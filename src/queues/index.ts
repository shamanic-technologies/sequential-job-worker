import { Queue } from "bullmq";
import { getRedis } from "../lib/redis.js";

// Queue names
export const QUEUE_NAMES = {
  CREATE_RUN: "create-run",
  GET_CAMPAIGN_INFO: "get-campaign-info",
  GET_BRAND_SALES_PROFILE: "get-brand-sales-profile",
  GET_CAMPAIGN_LEADS: "get-campaign-leads",
  EMAIL_GENERATE: "email-generate",
  EMAIL_SEND: "email-send",
  END_RUN: "end-run",
} as const;

// Queue instances (lazy initialized)
let queues: Record<string, Queue> | null = null;

export function getQueues(): Record<string, Queue> {
  if (!queues) {
    const connection = getRedis();

    queues = {
      [QUEUE_NAMES.CREATE_RUN]: new Queue(QUEUE_NAMES.CREATE_RUN, { connection }),
      [QUEUE_NAMES.GET_CAMPAIGN_INFO]: new Queue(QUEUE_NAMES.GET_CAMPAIGN_INFO, { connection }),
      [QUEUE_NAMES.GET_BRAND_SALES_PROFILE]: new Queue(QUEUE_NAMES.GET_BRAND_SALES_PROFILE, { connection }),
      [QUEUE_NAMES.GET_CAMPAIGN_LEADS]: new Queue(QUEUE_NAMES.GET_CAMPAIGN_LEADS, { connection }),
      [QUEUE_NAMES.EMAIL_GENERATE]: new Queue(QUEUE_NAMES.EMAIL_GENERATE, { connection }),
      [QUEUE_NAMES.EMAIL_SEND]: new Queue(QUEUE_NAMES.EMAIL_SEND, { connection }),
      [QUEUE_NAMES.END_RUN]: new Queue(QUEUE_NAMES.END_RUN, { connection }),
    };
  }
  return queues;
}

// Job data types

export interface CreateRunJobData {
  campaignId: string;
  clerkOrgId: string;
}

export interface GetCampaignInfoJobData {
  runId: string;
  campaignId: string;
  clerkOrgId: string;
}

export interface GetBrandSalesProfileJobData {
  campaignId: string;
  runId: string;
  clerkOrgId: string;
  brandUrl: string;
  brandId: string;
  searchParams: {
    personTitles?: string[];
    organizationLocations?: string[];
    qOrganizationKeywordTags?: string[];
    organizationNumEmployeesRanges?: string[];
    qOrganizationIndustryTagIds?: string[];
    qKeywords?: string;
  };
}

export interface GetCampaignLeadsJobData {
  runId: string;
  clerkOrgId: string;
  campaignId: string;
  brandId: string;
  maxLeads?: number | null;
  searchParams: {
    personTitles?: string[];
    organizationLocations?: string[];
    qOrganizationKeywordTags?: string[];
    organizationNumEmployeesRanges?: string[];
    qOrganizationIndustryTagIds?: string[];
    qKeywords?: string;
  };
  clientData: {
    companyName: string;
    brandUrl?: string;
    companyOverview?: string;
    valueProposition?: string;
    targetAudience?: string;
    customerPainPoints?: string[];
    keyFeatures?: string[];
    productDifferentiators?: string[];
    competitors?: string[];
    socialProof?: {
      caseStudies?: string[];
      testimonials?: string[];
      results?: string[];
    };
    callToAction?: string;
    additionalContext?: string;
  };
}

export interface EmailGenerateJobData {
  runId: string;
  clerkOrgId: string;
  campaignId: string;
  brandId: string;
  apolloEnrichmentId: string;
  leadData: {
    firstName: string;
    lastName?: string;
    title?: string;
    email?: string;
    linkedinUrl?: string;
    companyName: string;
    companyDomain?: string;
    companyIndustry?: string;
    companySize?: string;
    companyRevenueUsd?: string;
  };
  clientData: {
    companyName: string;
    brandUrl?: string;
    companyOverview?: string;
    valueProposition?: string;
    targetAudience?: string;
    customerPainPoints?: string[];
    keyFeatures?: string[];
    productDifferentiators?: string[];
    competitors?: string[];
    socialProof?: {
      caseStudies?: string[];
      testimonials?: string[];
      results?: string[];
    };
    callToAction?: string;
    additionalContext?: string;
  };
}

export interface EmailSendJobData {
  runId: string;
  clerkOrgId: string;
  campaignId: string;
  brandId: string;
  emailGenerationId: string;
  toEmail: string;
  recipientFirstName: string;
  recipientLastName?: string;
  recipientCompany: string;
  subject: string;
  bodyHtml: string;
}

export interface EndRunJobData {
  runId: string;
  campaignId: string;
  clerkOrgId: string;
  stats: { total: number; done: number; failed: number };
}
