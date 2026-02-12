import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, EmailSendJobData, EndRunJobData } from "../queues/index.js";
import { emailSendingService } from "../lib/service-client.js";
import { markJobDone } from "../lib/run-tracker.js";

interface SendResult {
  success: boolean;
  messageId?: string;
  provider?: string;
  error?: string;
}

/**
 * Email Send Worker
 *
 * Sends generated emails via EmailSendingService
 */
export function startEmailSendWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<EmailSendJobData>(
    QUEUE_NAMES.EMAIL_SEND,
    async (job: Job<EmailSendJobData>) => {
      const { runId, clerkOrgId, campaignId, brandId, emailGenerationId, toEmail, recipientFirstName, recipientLastName, recipientCompany, subject, bodyHtml } = job.data;

      if (!toEmail) {
        console.log(`[Sequential Job Worker][email-send] Skipping - no email address`);
        return { skipped: true };
      }

      console.log(`[Sequential Job Worker][email-send] Sending email to ${toEmail}`);

      try {
        const result = await emailSendingService.send({
          type: "broadcast",
          appId: "mcpfactory",
          clerkOrgId,
          brandId,
          campaignId,
          runId,
          to: toEmail,
          recipientFirstName,
          recipientLastName: recipientLastName || "",
          recipientCompany,
          subject,
          htmlBody: bodyHtml,
          tag: "cold-email",
          metadata: {
            emailGenerationId,
            source: "mcpfactory-worker",
          },
        }) as SendResult;

        if (!result.success) {
          throw new Error(`Email sending service returned failure: ${result.error || "unknown error"}`);
        }

        console.log(`[Sequential Job Worker][email-send] Sent email to ${toEmail} (messageId=${result.messageId}, provider=${result.provider})`);

        return { sent: true, result };
      } catch (error) {
        console.error(`[Sequential Job Worker][email-send] Error sending to ${toEmail}:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 20,
        duration: 60000, // Max 20 per minute (be conservative with email sending)
      },
    }
  );
  
  worker.on("completed", async (job) => {
    console.log(`[Sequential Job Worker][email-send] Job ${job.id} completed`);

    const { runId, campaignId, clerkOrgId } = job.data;
    const result = await markJobDone(runId, true);

    if (result.isLast) {
      const queues = getQueues();
      await queues[QUEUE_NAMES.END_RUN].add(
        `end-${runId}`,
        { runId, campaignId, clerkOrgId, stats: result } as EndRunJobData
      );
    }
  });

  worker.on("failed", async (job, err) => {
    console.error(`[Sequential Job Worker][email-send] Job ${job?.id} failed:`, err);

    if (job) {
      const { runId, campaignId, clerkOrgId } = job.data;
      const result = await markJobDone(runId, false);

      if (result.isLast) {
        const queues = getQueues();
        await queues[QUEUE_NAMES.END_RUN].add(
          `end-${runId}`,
          { runId, campaignId, clerkOrgId, stats: result } as EndRunJobData
        );
      }
    }
  });
  
  return worker;
}
