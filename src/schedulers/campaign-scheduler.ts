import { getQueues, QUEUE_NAMES, BrandUpsertJobData } from "../queues/index.js";
import { campaignService, leadService, runsService } from "../lib/service-client.js";
import type { Run, RunWithCosts } from "../lib/runs-client.js";

export interface Campaign {
  id: string;
  orgId: string;
  clerkOrgId: string;
  status: string;
  createdAt: string;
  maxBudgetDailyUsd?: string | null;
  maxBudgetWeeklyUsd?: string | null;
  maxBudgetMonthlyUsd?: string | null;
  maxBudgetTotalUsd?: string | null;
  maxLeads?: number | null;
  brandId?: string | null;
  personTitles?: string[];
  organizationLocations?: string[];
  qOrganizationKeywordTags?: string[];
  requestRaw?: Record<string, unknown>;
}

interface BudgetWindow {
  label: "daily" | "weekly" | "monthly" | "total";
  startedAfter: Date | null; // null = all time (for total budget)
  limitUsd: number;
}

interface BudgetCheckResult {
  exceeded: boolean;
  which?: "daily" | "weekly" | "monthly" | "total";
  spendUsd?: number;
  limitUsd?: number;
}

// Runs older than this are considered stale and will be marked failed
const STALE_RUN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// If the last N consecutive runs all failed, pause the campaign
const MAX_CONSECUTIVE_FAILURES = 3;

// Shutdown flag to stop polling during graceful shutdown
let isShuttingDown = false;
// Prevent concurrent polls (if a poll takes longer than the interval)
let isPolling = false;

export function stopCampaignScheduler() {
  isShuttingDown = true;
}

/**
 * Campaign Scheduler
 * Polls for ongoing campaigns and queues them if budget allows.
 * Campaigns run continuously (back-to-back) — budget is the only throttle.
 */
export function startCampaignScheduler(intervalMs: number = 30000): NodeJS.Timeout {
  console.log(`[Sequential Job Worker][scheduler] Starting campaign scheduler (interval: ${intervalMs}ms)`);
  isShuttingDown = false;

  async function pollCampaigns() {
    if (isShuttingDown || isPolling) {
      return;
    }
    isPolling = true;
    try {
      const result = await campaignService.listCampaigns() as { campaigns: Campaign[] };
      const campaigns = result.campaigns || [];

      const ongoingCampaigns = campaigns.filter(c => c.status === "ongoing");
      console.log(`[Sequential Job Worker][scheduler] Found ${ongoingCampaigns.length} ongoing campaigns`);

      for (const campaign of ongoingCampaigns) {
        const { shouldRun, hasRunningRun } = await shouldRunCampaign(campaign);

        console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: shouldRun=${shouldRun}, hasRunningRun=${hasRunningRun}`);

        if (hasRunningRun) {
          console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: has running run, skipping`);
          continue;
        }

        if (shouldRun) {
          console.log(`[Sequential Job Worker][scheduler] Queueing campaign ${campaign.id} for org ${campaign.clerkOrgId}`);

          const queues = getQueues();
          await queues[QUEUE_NAMES.BRAND_UPSERT].add(
            `campaign-${campaign.id}-${Date.now()}`,
            {
              campaignId: campaign.id,
              clerkOrgId: campaign.clerkOrgId,
            } as BrandUpsertJobData
          );
        }
      }
    } catch (error) {
      console.error("[Sequential Job Worker][scheduler] Error polling campaigns:", error);
    } finally {
      isPolling = false;
    }
  }

  // Run immediately on start
  pollCampaigns();

  // Then run on interval
  const interval = setInterval(pollCampaigns, intervalMs);

  return interval;
}

interface ShouldRunResult {
  shouldRun: boolean;
  hasRunningRun: boolean;
}

export async function getRunsForCampaign(campaign: Campaign): Promise<Run[]> {
  const runsOrgId = await runsService.ensureOrganization(campaign.clerkOrgId);
  console.log(`[Sequential Job Worker][scheduler] getRunsForCampaign: clerkOrgId=${campaign.clerkOrgId} runsOrgId=${runsOrgId} taskName=${campaign.id}`);
  const result = await runsService.listRuns({
    organizationId: runsOrgId,
    serviceName: "campaign-service",
    taskName: campaign.id,
    limit: 200,
  });
  console.log(`[Sequential Job Worker][scheduler] listRuns returned ${result.runs.length} runs: ${JSON.stringify(result.runs.map(r => ({ id: r.id, status: r.status })))}`);
  return result.runs;
}

async function shouldRunCampaign(campaign: Campaign): Promise<ShouldRunResult> {
  try {
    let runs = await getRunsForCampaign(campaign);

    // Cleanup stale runs (running for too long = probably crashed)
    const now = Date.now();
    for (const run of runs) {
      if (run.status === "running" &&
          now - new Date(run.createdAt).getTime() > STALE_RUN_TIMEOUT_MS) {
        console.log(`[Sequential Job Worker][scheduler] Run ${run.id} is stale (>${STALE_RUN_TIMEOUT_MS / 60000} min), marking as failed`);
        try {
          await runsService.updateRun(run.id, "failed");
        } catch (err) {
          console.error(`[Sequential Job Worker][scheduler] Failed to mark stale run ${run.id} as failed:`, err);
        }
      }
    }

    // Re-fetch runs after cleanup
    runs = await getRunsForCampaign(campaign);

    const hasRunningRun = runs.some(r => r.status === "running");

    console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id} has ${runs.length} runs (${runs.filter(r => r.status === "running").length} running)`);

    // Budget + volume are the gates — if no running run, check both
    let shouldRun = false;
    if (!hasRunningRun) {
      const budgetResult = await isBudgetExceeded(campaign, runs);
      if (budgetResult.exceeded) {
        console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: ${budgetResult.which} budget exceeded ($${budgetResult.spendUsd?.toFixed(2)} >= $${budgetResult.limitUsd?.toFixed(2)})`);

        // Auto-stop campaign if total budget is exhausted
        if (budgetResult.which === "total") {
          console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: total budget exhausted, stopping campaign`);
          try {
            await campaignService.updateCampaign(campaign.id, campaign.clerkOrgId, { status: "stopped" });
          } catch (err) {
            console.error(`[Sequential Job Worker][scheduler] Failed to auto-stop campaign ${campaign.id}:`, err);
          }
        }

        shouldRun = false;
      } else {
        // Check volume limit
        const volumeResult = await isVolumeExceeded(campaign, runs);
        if (volumeResult.exceeded) {
          console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: volume exceeded (${volumeResult.totalServed} >= ${volumeResult.maxLeads})`);

          // Auto-stop campaign when volume cap reached
          console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: max leads reached, stopping campaign`);
          try {
            await campaignService.updateCampaign(campaign.id, campaign.clerkOrgId, { status: "stopped" });
          } catch (err) {
            console.error(`[Sequential Job Worker][scheduler] Failed to auto-stop campaign ${campaign.id}:`, err);
          }

          shouldRun = false;
        } else {
          // Check for consecutive failures (e.g. lead buffer exhausted)
          const consecutiveFailures = countConsecutiveFailures(runs);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: ${consecutiveFailures} consecutive failed runs, stopping campaign`);
            try {
              await campaignService.updateCampaign(campaign.id, campaign.clerkOrgId, { status: "stopped" });
            } catch (err) {
              console.error(`[Sequential Job Worker][scheduler] Failed to auto-stop campaign ${campaign.id} (consecutive failures):`, err);
            }
            shouldRun = false;
          } else {
            shouldRun = true;
          }
        }
      }
    }

    return { shouldRun, hasRunningRun };
  } catch (error) {
    // Fail closed — if we can't determine budget, don't run
    console.error(`[Sequential Job Worker][scheduler] Error checking runs for ${campaign.id}, failing closed:`, error);
    return { shouldRun: false, hasRunningRun: false };
  }
}

/**
 * Count how many of the most recent completed runs failed consecutively.
 * Runs are assumed newest-first from the API.
 */
function countConsecutiveFailures(runs: Run[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.status === "running") continue; // skip in-progress
    if (run.status === "failed") {
      count++;
    } else {
      break; // first non-failed completed run stops the streak
    }
  }
  return count;
}

export function getBudgetWindows(campaign: Campaign): BudgetWindow[] {
  const windows: BudgetWindow[] = [];
  const now = new Date();

  if (campaign.maxBudgetDailyUsd) {
    windows.push({
      label: "daily",
      startedAfter: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      limitUsd: parseFloat(campaign.maxBudgetDailyUsd),
    });
  }

  if (campaign.maxBudgetWeeklyUsd) {
    windows.push({
      label: "weekly",
      startedAfter: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      limitUsd: parseFloat(campaign.maxBudgetWeeklyUsd),
    });
  }

  if (campaign.maxBudgetMonthlyUsd) {
    windows.push({
      label: "monthly",
      startedAfter: new Date(now.getFullYear(), now.getMonth(), 1),
      limitUsd: parseFloat(campaign.maxBudgetMonthlyUsd),
    });
  }

  if (campaign.maxBudgetTotalUsd) {
    windows.push({
      label: "total",
      startedAfter: null, // all time
      limitUsd: parseFloat(campaign.maxBudgetTotalUsd),
    });
  }

  return windows;
}

export async function isBudgetExceeded(campaign: Campaign, allRuns: Run[]): Promise<BudgetCheckResult> {
  const windows = getBudgetWindows(campaign);

  if (windows.length === 0) {
    // No budget fields set — fail closed (shouldn't happen since creation requires at least one)
    console.warn(`[Sequential Job Worker][scheduler] Campaign ${campaign.id}: no budget fields set, blocking run`);
    return { exceeded: true, which: "total", spendUsd: 0, limitUsd: 0 };
  }

  // Find the broadest window to minimize the number of runs we need costs for
  // total (null startedAfter) is broadest, then monthly, weekly, daily
  const broadestWindow = windows.reduce((a, b) => {
    if (a.startedAfter === null) return a;
    if (b.startedAfter === null) return b;
    return a.startedAfter < b.startedAfter ? a : b;
  });

  // Filter runs to the broadest window
  const runsInWindow = broadestWindow.startedAfter === null
    ? allRuns
    : allRuns.filter(r => new Date(r.createdAt) >= broadestWindow.startedAfter!);

  if (runsInWindow.length === 0) {
    return { exceeded: false };
  }

  // Single batch call for costs
  const runIds = runsInWindow.map(r => r.id);
  const runsWithCosts = await runsService.getRunsBatch(runIds);

  // Check each window
  for (const window of windows) {
    let spendCents = 0;

    for (const run of runsWithCosts.values()) {
      const inWindow = window.startedAfter === null ||
        new Date(run.createdAt) >= window.startedAfter;
      if (inWindow) {
        spendCents += parseFloat(run.totalCostInUsdCents) || 0;
      }
    }

    const spendUsd = spendCents / 100;
    console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id} ${window.label} spend: $${spendUsd.toFixed(2)} / $${window.limitUsd.toFixed(2)}`);

    if (spendUsd >= window.limitUsd) {
      return { exceeded: true, which: window.label, spendUsd, limitUsd: window.limitUsd };
    }
  }

  return { exceeded: false };
}

interface VolumeCheckResult {
  exceeded: boolean;
  totalServed?: number;
  maxLeads?: number;
}

export async function isVolumeExceeded(campaign: Campaign, runs: Run[]): Promise<VolumeCheckResult> {
  if (!campaign.maxLeads || !campaign.brandId) {
    return { exceeded: false };
  }

  // Count completed runs as a reliable local count (1 lead per run)
  const completedRunCount = runs.filter(r => r.status === "completed").length;

  try {
    const stats = await leadService.getStats(campaign.clerkOrgId, { brandId: campaign.brandId, campaignId: campaign.id });
    // Use the higher of stats vs completed runs to prevent under-counting
    const totalServed = Math.max(stats.totalServed, completedRunCount);

    console.log(`[Sequential Job Worker][scheduler] Campaign ${campaign.id} volume: ${totalServed} / ${campaign.maxLeads} (stats=${stats.totalServed}, runs=${completedRunCount})`);

    if (totalServed >= campaign.maxLeads) {
      return { exceeded: true, totalServed, maxLeads: campaign.maxLeads };
    }

    return { exceeded: false, totalServed, maxLeads: campaign.maxLeads };
  } catch (error) {
    // 404 means no stats yet for this brand — fall back to completed run count
    const is404 = error instanceof Error && error.message.includes("Service call failed: 404");
    if (is404) {
      console.log(`[Sequential Job Worker][scheduler] No stats found for campaign ${campaign.id} brand ${campaign.brandId}, using completed run count: ${completedRunCount}`);

      if (completedRunCount >= campaign.maxLeads) {
        return { exceeded: true, totalServed: completedRunCount, maxLeads: campaign.maxLeads };
      }
      return { exceeded: false, totalServed: completedRunCount, maxLeads: campaign.maxLeads };
    }

    // Fail closed on unexpected errors — if we can't check volume, don't run
    console.error(`[Sequential Job Worker][scheduler] Failed to check volume for campaign ${campaign.id}, failing closed:`, error);
    return { exceeded: true, totalServed: 0, maxLeads: campaign.maxLeads };
  }
}

/**
 * Re-trigger a campaign run immediately after the previous one completes.
 * Checks budget, volume, and consecutive failures before queueing.
 */
export async function retriggerCampaignIfNeeded(campaignId: string, clerkOrgId: string): Promise<void> {
  try {
    const campaignResult = await campaignService.getCampaign(campaignId, clerkOrgId) as { campaign: Campaign };
    const campaign = campaignResult.campaign;
    // API response may omit clerkOrgId — ensure it's set from the job data
    if (!campaign.clerkOrgId) {
      campaign.clerkOrgId = clerkOrgId;
    }

    if (campaign.status !== "ongoing") {
      console.log(`[Sequential Job Worker][retrigger] Campaign ${campaignId} status=${campaign.status}, skipping`);
      return;
    }

    const runs = await getRunsForCampaign(campaign);

    const budgetResult = await isBudgetExceeded(campaign, runs);
    if (budgetResult.exceeded) {
      console.log(`[Sequential Job Worker][retrigger] Campaign ${campaignId}: ${budgetResult.which} budget exceeded ($${budgetResult.spendUsd?.toFixed(2)} >= $${budgetResult.limitUsd?.toFixed(2)})`);
      if (budgetResult.which === "total") {
        await campaignService.updateCampaign(campaignId, clerkOrgId, { status: "stopped" });
      }
      return;
    }

    const volumeResult = await isVolumeExceeded(campaign, runs);
    if (volumeResult.exceeded) {
      console.log(`[Sequential Job Worker][retrigger] Campaign ${campaignId}: volume exceeded (${volumeResult.totalServed} >= ${volumeResult.maxLeads}), stopping`);
      await campaignService.updateCampaign(campaignId, clerkOrgId, { status: "stopped" });
      return;
    }

    const consecutiveFailures = countConsecutiveFailures(runs);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[Sequential Job Worker][retrigger] Campaign ${campaignId}: ${consecutiveFailures} consecutive failures, stopping`);
      await campaignService.updateCampaign(campaignId, clerkOrgId, { status: "stopped" });
      return;
    }

    console.log(`[Sequential Job Worker][retrigger] Re-triggering campaign ${campaignId}`);
    const queues = getQueues();
    await queues[QUEUE_NAMES.BRAND_UPSERT].add(
      `campaign-${campaignId}-${Date.now()}`,
      { campaignId, clerkOrgId } as BrandUpsertJobData
    );
  } catch (error) {
    console.error(`[Sequential Job Worker][retrigger] Error re-triggering campaign ${campaignId}:`, error);
  }
}
