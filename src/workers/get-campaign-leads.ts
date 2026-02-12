import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, GetCampaignLeadsJobData, EmailGenerateJobData } from "../queues/index.js";
import { leadService } from "../lib/service-client.js";
import { initRunTracking, finalizeRun } from "../lib/run-tracker.js";

interface BufferLead {
  email: string;
  externalId?: string;
  data: Record<string, unknown>;
}

/**
 * Get Campaign Leads Worker (concurrency=3)
 *
 * Step 4: Pulls a single deduplicated lead from lead-service buffer per run.
 * The scheduler handles back-to-back runs, gated by budget and volume (maxLeads).
 * One lead per run = granular control over spend and volume.
 */
export function startGetCampaignLeadsWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<GetCampaignLeadsJobData>(
    QUEUE_NAMES.GET_CAMPAIGN_LEADS,
    async (job: Job<GetCampaignLeadsJobData>) => {
      const { runId, clerkOrgId, campaignId, brandId, searchParams, clientData } = job.data;

      console.log(`[Sequential Job Worker][get-campaign-leads] Starting for run ${runId}, campaign ${campaignId}, brand ${brandId}`);
      console.log(`[Sequential Job Worker][get-campaign-leads] Client: ${clientData?.companyName || "(no client data)"}`);

      try {
        // Pull a single deduplicated lead from buffer
        // Lead-service handles Apollo search internally when buffer is empty
        const result = await leadService.next(clerkOrgId, {
          campaignId,
          brandId,
          parentRunId: runId,
          searchParams,
        }) as { found: boolean; lead?: BufferLead };

        const leads: BufferLead[] = [];
        if (result.found && result.lead) {
          leads.push(result.lead);
        }

        console.log(`[Sequential Job Worker][get-campaign-leads] Pulled ${leads.length} leads from buffer`);

        // Queue email generation for each lead
        const queues = getQueues();
        const jobs = leads
          .filter((lead) => lead.data?.email)
          .map((lead) => ({
            name: `generate-${lead.externalId || lead.email}`,
            data: {
              runId,
              clerkOrgId,
              campaignId,
              brandId,
              apolloEnrichmentId: lead.externalId || "",
              leadData: {
                firstName: lead.data.firstName as string,
                lastName: lead.data.lastName as string | undefined,
                title: lead.data.title as string | undefined,
                email: lead.data.email as string,
                linkedinUrl: lead.data.linkedinUrl as string | undefined,
                companyName: (lead.data.organizationName as string) || "",
                companyDomain: lead.data.organizationDomain as string | undefined,
                companyIndustry: lead.data.organizationIndustry as string | undefined,
                companySize: lead.data.organizationSize as string | undefined,
                companyRevenueUsd: lead.data.organizationRevenueUsd as string | undefined,
              },
              clientData: clientData || { companyName: "" },
            } as EmailGenerateJobData,
          }));

        if (jobs.length > 0) {
          await initRunTracking(runId, jobs.length);
          await queues[QUEUE_NAMES.EMAIL_GENERATE].addBulk(jobs);
          console.log(`[Sequential Job Worker][get-campaign-leads] Queued ${jobs.length} email generation jobs`);
        } else {
          console.log(`[Sequential Job Worker][get-campaign-leads] No leads to process, finalizing run`);
          await finalizeRun(runId, { total: 0, done: 0, failed: 0 });
        }

        return { leadsFound: leads.length, jobsQueued: jobs.length };
      } catch (error) {
        console.error(`[Sequential Job Worker][get-campaign-leads] Error:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[Sequential Job Worker][get-campaign-leads] Job ${job.id} completed`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[Sequential Job Worker][get-campaign-leads] Job ${job?.id} failed:`, err);
    if (job) {
      const { runId } = job.data;
      await finalizeRun(runId, { total: 0, done: 0, failed: 0 });
    }
  });

  return worker;
}
