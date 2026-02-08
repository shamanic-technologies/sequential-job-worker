import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { QUEUE_NAMES, EmailSendJobData } from "../queues/index.js";
import { emailSendingService } from "../lib/service-client.js";

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
        });

        console.log(`[Sequential Job Worker][email-send] Sent email to ${toEmail}`);

        return { sent: true, result };
      } catch (error) {
        console.error(`[Sequential Job Worker][email-send] Error:`, error);
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
  
  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][email-send] Job ${job.id} completed`);
  });
  
  worker.on("failed", (job, err) => {
    console.error(`[Sequential Job Worker][email-send] Job ${job?.id} failed:`, err);
  });
  
  return worker;
}
