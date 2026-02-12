import { getRedis } from "./redis.js";

const RUN_PREFIX = "run:";
const TOTAL_KEY = ":total";
const DONE_KEY = ":done";
const FAILED_KEY = ":failed";
const TTL_SECONDS = 86400; // 24 hours

/**
 * Track job completion for a campaign run.
 * Uses Redis atomic counters to know when all jobs are done.
 *
 * Run finalization (updateRun + retrigger) is handled by the end-run worker.
 */

/**
 * Initialize tracking for a run with N expected jobs
 */
export async function initRunTracking(runId: string, totalJobs: number): Promise<void> {
  const redis = getRedis();
  const prefix = `${RUN_PREFIX}${runId}`;

  await redis.set(`${prefix}${TOTAL_KEY}`, totalJobs, "EX", TTL_SECONDS);
  await redis.set(`${prefix}${DONE_KEY}`, 0, "EX", TTL_SECONDS);
  await redis.set(`${prefix}${FAILED_KEY}`, 0, "EX", TTL_SECONDS);

  console.log(`[Sequential Job Worker][run-tracker] Initialized run ${runId} with ${totalJobs} expected jobs`);
}

/**
 * Mark a job as completed (success or failure)
 * Returns true if this was the last job
 */
export async function markJobDone(
  runId: string,
  success: boolean
): Promise<{ isLast: boolean; total: number; done: number; failed: number }> {
  const redis = getRedis();
  const prefix = `${RUN_PREFIX}${runId}`;

  // Atomically increment counters
  const done = await redis.incr(`${prefix}${DONE_KEY}`);
  if (!success) {
    await redis.incr(`${prefix}${FAILED_KEY}`);
  }

  const total = parseInt(await redis.get(`${prefix}${TOTAL_KEY}`) || "0", 10);
  const failed = parseInt(await redis.get(`${prefix}${FAILED_KEY}`) || "0", 10);

  const isLast = done >= total && total > 0;

  console.log(`[Sequential Job Worker][run-tracker] Run ${runId}: ${done}/${total} done (${failed} failed), isLast=${isLast}`);

  return { isLast, total, done, failed };
}

/**
 * Clean up Redis tracking keys for a run (called by end-run worker)
 */
export async function cleanupRunTracking(runId: string): Promise<void> {
  const redis = getRedis();
  const prefix = `${RUN_PREFIX}${runId}`;

  await redis.del(`${prefix}${TOTAL_KEY}`);
  await redis.del(`${prefix}${DONE_KEY}`);
  await redis.del(`${prefix}${FAILED_KEY}`);
}
