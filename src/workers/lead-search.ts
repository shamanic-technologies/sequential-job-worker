import { Worker, Job } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getQueues, QUEUE_NAMES, LeadSearchJobData, EmailGenerateJobData } from "../queues/index.js";
import { leadService } from "../lib/service-client.js";
import { initRunTracking, finalizeRun } from "../lib/run-tracker.js";

interface BufferLead {
  email: string;
  externalId?: string;
  data: Record<string, unknown>;
}

const MAX_LEADS_PER_RUN = 50;

/**
 * Lead Search Worker
 *
 * Pulls deduplicated leads from lead-service buffer.
 * Lead-service handles Apollo search internally when buffer is empty.
 */
export function startLeadSearchWorker(): Worker {
  const connection = getRedis();

  const worker = new Worker<LeadSearchJobData>(
    QUEUE_NAMES.LEAD_SEARCH,
    async (job: Job<LeadSearchJobData>) => {
      const { runId, clerkOrgId, campaignId, brandId, searchParams, clientData } = job.data;
      const namespace = brandId;

      console.log(`[lead-search] Starting for run ${runId}, campaign ${campaignId}, brand ${brandId}`);
      console.log(`[lead-search] Client: ${clientData?.companyName || "(no client data)"}`);

      try {
        // Pull deduplicated leads from buffer
        // Lead-service handles Apollo search internally when buffer is empty
        const leads: BufferLead[] = [];
        while (leads.length < MAX_LEADS_PER_RUN) {
          const result = await leadService.next(clerkOrgId, {
            namespace,
            parentRunId: runId,
            brandId,
            searchParams,
          }) as { found: boolean; lead?: BufferLead };

          if (!result.found || !result.lead) break;
          leads.push(result.lead);
        }

        console.log(`[lead-search] Pulled ${leads.length} leads from buffer`);

        // Queue email generation for each lead
        const queues = getQueues();
        const jobs = leads
          .filter((lead) => lead.data?.email)
          .map((lead) => ({
            name: `generate-${lead.externalId || lead.email}`,
            data: {
              runId,
              clerkOrgId,
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
          console.log(`[lead-search] Queued ${jobs.length} email generation jobs`);
        } else {
          console.log(`[lead-search] No leads to process, finalizing run`);
          await finalizeRun(runId, { total: 0, done: 0, failed: 0 });
        }

        return { leadsFound: leads.length, jobsQueued: jobs.length };
      } catch (error) {
        console.error(`[lead-search] Error:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[lead-search] Job ${job.id} completed`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`[lead-search] Job ${job?.id} failed:`, err);
    if (job) {
      const { runId } = job.data;
      await finalizeRun(runId, { total: 0, done: 0, failed: 0 });
    }
  });

  return worker;
}
