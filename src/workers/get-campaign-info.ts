import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, GetCampaignInfoJobData, GetBrandSalesProfileJobData, EndRunJobData } from "../queues/index.js";
import { campaignService } from "../lib/service-client.js";

interface CampaignDetails {
  id: string;
  name: string;
  brandId?: string;
  brandDomain?: string;
  brandName?: string;
  brandUrl?: string;
  appId?: string;
  createdByUserId?: string;
  personTitles?: string[];
  organizationLocations?: string[];
  qOrganizationKeywordTags?: string[];
  organizationNumEmployeesRanges?: string[];
  qOrganizationIndustryTagIds?: string[];
  qKeywords?: string;
  requestRaw?: {
    brandUrl?: string;
  };
}

/**
 * Get Campaign Info Worker (concurrency=5)
 *
 * Step 2: Fetches campaign details from campaign-service, then queues get-brand-sales-profile.
 * Validates that brandId is present (set by api-service at campaign creation).
 */
export function startGetCampaignInfoWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<GetCampaignInfoJobData>(
    QUEUE_NAMES.GET_CAMPAIGN_INFO,
    async (job: Job<GetCampaignInfoJobData>) => {
      const { runId, campaignId, clerkOrgId } = job.data;

      console.log(`[Sequential Job Worker][get-campaign-info] Starting for campaign ${campaignId}, run ${runId}`);

      try {
        const campaignResult = await campaignService.getCampaign(campaignId, clerkOrgId) as { campaign: CampaignDetails };
        const campaign = campaignResult.campaign;

        const brandUrl = campaign.brandUrl || campaign.requestRaw?.brandUrl;
        if (!brandUrl) {
          throw new Error(`Campaign ${campaignId} has no brandUrl`);
        }

        const brandId = campaign.brandId;
        if (!brandId) {
          throw new Error(`Campaign ${campaignId} has no brandId`);
        }

        const brandDomain = new URL(brandUrl).hostname.replace(/^www\./, '');
        console.log(`[Sequential Job Worker][get-campaign-info] Brand: ${brandDomain} (${brandUrl}), brandId: ${brandId}`);

        const searchParams = {
          personTitles: campaign.personTitles,
          organizationLocations: campaign.organizationLocations,
          qOrganizationKeywordTags: campaign.qOrganizationKeywordTags,
          organizationNumEmployeesRanges: campaign.organizationNumEmployeesRanges,
          qOrganizationIndustryTagIds: campaign.qOrganizationIndustryTagIds,
          qKeywords: campaign.qKeywords,
        };

        const queues = getQueues();
        await queues[QUEUE_NAMES.GET_BRAND_SALES_PROFILE].add(
          `profile-${runId}`,
          {
            campaignId,
            runId,
            clerkOrgId,
            brandUrl,
            brandId,
            appId: campaign.appId || "mcpfactory",
            clerkUserId: campaign.createdByUserId || undefined,
            searchParams,
          } as GetBrandSalesProfileJobData
        );

        console.log(`[Sequential Job Worker][get-campaign-info] Queued get-brand-sales-profile for run ${runId}`);

        return { runId, brandUrl, brandId };
      } catch (error) {
        console.error(`[Sequential Job Worker][get-campaign-info] Error:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on("ready", () => {
    console.log(`[Sequential Job Worker][get-campaign-info] Worker ready (concurrency=5)`);
  });

  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][get-campaign-info] Job ${job.id} completed`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[Sequential Job Worker][get-campaign-info] Job ${job?.id} failed:`, err);
    if (job) {
      const { runId, campaignId, clerkOrgId } = job.data;
      const queues = getQueues();
      await queues[QUEUE_NAMES.END_RUN].add(
        `end-${runId}`,
        { runId, campaignId, clerkOrgId, stats: { total: 0, done: 0, failed: 0 } } as EndRunJobData
      );
    }
  });

  console.log(`[Sequential Job Worker][get-campaign-info] Worker started on queue: ${QUEUE_NAMES.GET_CAMPAIGN_INFO}`);

  return worker;
}
