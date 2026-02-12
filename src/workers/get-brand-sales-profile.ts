import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, GetBrandSalesProfileJobData, GetCampaignLeadsJobData } from "../queues/index.js";
import { brandService } from "../lib/service-client.js";
import { finalizeRun } from "../lib/run-tracker.js";

interface SalesProfileResponse {
  cached?: boolean;
  brandId?: string;
  profile?: {
    companyName: string | null;
    valueProposition: string | null;
    companyOverview: string | null;
    targetAudience: string | null;
    customerPainPoints: string[];
    keyFeatures: string[];
    productDifferentiators: string[];
    competitors: string[];
    socialProof: {
      caseStudies: string[];
      testimonials: string[];
      results: string[];
    };
    callToAction: string | null;
    additionalContext: string | null;
  };
}

/**
 * Get Brand Sales Profile Worker (concurrency=5)
 *
 * Step 3: Fetches sales profile from brand-service for email personalization.
 * brandId is guaranteed to be present (set by api-service at campaign creation).
 * On profile fetch failure, falls back to domain as company name.
 */
export function startGetBrandSalesProfileWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<GetBrandSalesProfileJobData>(
    QUEUE_NAMES.GET_BRAND_SALES_PROFILE,
    async (job: Job<GetBrandSalesProfileJobData>) => {
      const { campaignId, runId, clerkOrgId, brandUrl, brandId, searchParams } = job.data;

      const brandDomain = new URL(brandUrl).hostname.replace(/^www\./, '');
      console.log(`[Sequential Job Worker][get-brand-sales-profile] Fetching profile for ${brandDomain} (${brandUrl})`);

      try {
        let clientData: GetCampaignLeadsJobData["clientData"] = { companyName: brandDomain, brandUrl };

        try {
          const profileResult = await brandService.getSalesProfile(
            clerkOrgId,
            brandUrl,
            "byok",
            runId
          ) as SalesProfileResponse;

          if (profileResult?.profile) {
            const p = profileResult.profile;
            clientData = {
              companyName: p.companyName || brandDomain,
              companyOverview: p.companyOverview || undefined,
              valueProposition: p.valueProposition || undefined,
              targetAudience: p.targetAudience || undefined,
              customerPainPoints: p.customerPainPoints?.length ? p.customerPainPoints : undefined,
              keyFeatures: p.keyFeatures?.length ? p.keyFeatures : undefined,
              productDifferentiators: p.productDifferentiators?.length ? p.productDifferentiators : undefined,
              competitors: p.competitors?.length ? p.competitors : undefined,
              socialProof: p.socialProof || undefined,
              callToAction: p.callToAction || undefined,
              additionalContext: p.additionalContext || undefined,
              brandUrl,
            };
            console.log(`[Sequential Job Worker][get-brand-sales-profile] Got profile: ${clientData.companyName} (cached: ${profileResult.cached})`);
          }
        } catch (profileError) {
          console.error(`[Sequential Job Worker][get-brand-sales-profile] Failed to get profile, using domain fallback:`, profileError);
          console.log(`[Sequential Job Worker][get-brand-sales-profile] Using domain as fallback company name: ${brandDomain}`);
        }

        // Queue get-campaign-leads
        const queues = getQueues();
        await queues[QUEUE_NAMES.GET_CAMPAIGN_LEADS].add(
          `leads-${runId}`,
          {
            runId,
            clerkOrgId,
            campaignId,
            brandId,
            searchParams,
            clientData,
          } as GetCampaignLeadsJobData
        );

        console.log(`[Sequential Job Worker][get-brand-sales-profile] Queued get-campaign-leads for run ${runId}`);
        console.log(`[Sequential Job Worker][get-brand-sales-profile] Search params:`, JSON.stringify(searchParams));

        return { runId, brandUrl, hasProfile: !!clientData.companyName };
      } catch (error) {
        console.error(`[Sequential Job Worker][get-brand-sales-profile] Error:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on("ready", () => {
    console.log(`[Sequential Job Worker][get-brand-sales-profile] Worker ready (concurrency=5)`);
  });

  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][get-brand-sales-profile] Job ${job.id} completed`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[Sequential Job Worker][get-brand-sales-profile] Job ${job?.id} failed:`, err);
    if (job) {
      const { runId } = job.data;
      await finalizeRun(runId, { total: 0, done: 0, failed: 0 });
    }
  });

  console.log(`[Sequential Job Worker][get-brand-sales-profile] Worker started on queue: ${QUEUE_NAMES.GET_BRAND_SALES_PROFILE}`);

  return worker;
}
