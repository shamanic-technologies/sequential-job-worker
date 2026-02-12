import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { QUEUE_NAMES, EndRunJobData } from "../queues/index.js";
import { runsService } from "../lib/service-client.js";
import { cleanupRunTracking } from "../lib/run-tracker.js";
import { retriggerCampaignIfNeeded } from "../schedulers/campaign-scheduler.js";

/**
 * End Run Worker (concurrency=5)
 *
 * Step 7: Finalizes a run — updates status in runs-service, cleans up Redis
 * tracking keys, and re-triggers the campaign if appropriate.
 *
 * All workers route here instead of calling finalizeRun directly, so run
 * completion logic lives in one place.
 */
export function startEndRunWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<EndRunJobData>(
    QUEUE_NAMES.END_RUN,
    async (job: Job<EndRunJobData>) => {
      const { runId, campaignId, clerkOrgId, stats } = job.data;

      const status = stats.failed === stats.total ? "failed" : "completed";

      console.log(`[Sequential Job Worker][end-run] Finalizing run ${runId} status=${status} (${stats.done - stats.failed} success, ${stats.failed} failed, ${stats.total} total)`);

      try {
        await runsService.updateRun(runId, status);
        await cleanupRunTracking(runId);

        console.log(`[Sequential Job Worker][end-run] Run ${runId} finalized, re-triggering campaign ${campaignId}`);
        await retriggerCampaignIfNeeded(campaignId, clerkOrgId);

        return { runId, status };
      } catch (error) {
        console.error(`[Sequential Job Worker][end-run] Error finalizing run ${runId}:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on("ready", () => {
    console.log(`[Sequential Job Worker][end-run] Worker ready (concurrency=5)`);
  });

  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][end-run] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Sequential Job Worker][end-run] Job ${job?.id} failed:`, err);
  });

  console.log(`[Sequential Job Worker][end-run] Worker started on queue: ${QUEUE_NAMES.END_RUN}`);

  return worker;
}
