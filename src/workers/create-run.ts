import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, CreateRunJobData, GetCampaignInfoJobData } from "../queues/index.js";
import { runsService } from "../lib/service-client.js";

/**
 * Create Run Worker (concurrency=1)
 *
 * Step 1: Creates a run record in runs-service, then queues get-campaign-info.
 * Non-concurrent to avoid race conditions on run creation.
 */
export function startCreateRunWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<CreateRunJobData>(
    QUEUE_NAMES.CREATE_RUN,
    async (job: Job<CreateRunJobData>) => {
      const { campaignId, clerkOrgId } = job.data;

      console.log(`[Sequential Job Worker][create-run] Starting for campaign ${campaignId}`);

      try {
        console.log(`[Sequential Job Worker][create-run] createRun: clerkOrgId=${clerkOrgId} taskName=${campaignId}`);
        const run = await runsService.createRun({
          clerkOrgId,
          appId: "mcpfactory",
          serviceName: "campaign-service",
          taskName: campaignId,
          campaignId,
        });
        const runId = run.id;
        console.log(`[Sequential Job Worker][create-run] Created run ${runId} (status=${run.status})`);

        const queues = getQueues();
        await queues[QUEUE_NAMES.GET_CAMPAIGN_INFO].add(
          `info-${runId}`,
          {
            runId,
            campaignId,
            clerkOrgId,
          } as GetCampaignInfoJobData
        );

        console.log(`[Sequential Job Worker][create-run] Queued get-campaign-info for run ${runId}`);

        return { runId };
      } catch (error) {
        console.error(`[Sequential Job Worker][create-run] Error:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on("ready", () => {
    console.log(`[Sequential Job Worker][create-run] Worker ready (concurrency=1)`);
  });

  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][create-run] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Sequential Job Worker][create-run] Job ${job?.id} failed:`, err);
  });

  console.log(`[Sequential Job Worker][create-run] Worker started on queue: ${QUEUE_NAMES.CREATE_RUN}`);

  return worker;
}
