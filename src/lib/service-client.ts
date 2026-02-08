/**
 * Generic service client for calling other microservices
 *
 * Each service has its own API key env var:
 * - POSTMARK_SERVICE_API_KEY for postmark-service
 * - BRAND_SERVICE_API_KEY for brand-service
 * - CAMPAIGN_SERVICE_API_KEY for campaign-service
 * - RUNS_SERVICE_API_KEY for runs-service
 * - etc.
 */

import {
  ensureOrganization,
  createRun,
  updateRun as updateRunInService,
  addCosts,
  listRuns,
  getRun,
  getRunsBatch,
  getRunSummary,
  type Run,
  type RunWithCosts,
  type CreateRunParams,
  type CostItem,
  type ListRunsParams,
  type RunSummaryParams,
  type SummaryBreakdown,
} from "./runs-client.js";

interface ServiceCallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  clerkOrgId?: string;
  apiKey?: string; // Service-specific API key
  extraHeaders?: Record<string, string>;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export async function callService(
  serviceUrl: string,
  path: string,
  options: ServiceCallOptions
): Promise<unknown> {
  const { method = "GET", body, clerkOrgId, apiKey, extraHeaders } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Add service secret for auth
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  // Only add Clerk org header if provided (some services don't need it)
  if (clerkOrgId) {
    headers["X-Clerk-Org-Id"] = clerkOrgId;
  }

  // Add any extra headers
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${serviceUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return response.json();
      }

      const error = await response.text();
      lastError = new Error(`Service call failed: ${response.status} - ${error}`);

      // Only retry on 5xx (server errors), not 4xx (client errors)
      if (response.status < 500) {
        throw lastError;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry client errors (re-thrown 4xx above)
      if (lastError.message.startsWith("Service call failed: 4")) {
        throw lastError;
      }
    }

    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`[Sequential Job Worker] Retrying ${method} ${path} (attempt ${attempt + 2}/${MAX_RETRIES + 1}) in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// Service-specific clients with their own API keys

export const campaignService = {
  url: process.env.CAMPAIGN_SERVICE_URL || "http://localhost:3003",
  apiKey: process.env.CAMPAIGN_SERVICE_API_KEY,
  
  async listCampaigns() {
    return callService(this.url, "/campaigns/list", {
      method: "GET",
      apiKey: this.apiKey,
    });
  },

  async getCampaign(campaignId: string, clerkOrgId: string) {
    return callService(this.url, `/campaigns/${campaignId}`, {
      method: "GET",
      apiKey: this.apiKey,
      clerkOrgId,
    });
  },

  async getRuns(campaignId: string) {
    return callService(this.url, `/campaigns/${campaignId}/runs/list`, {
      method: "GET",
      apiKey: this.apiKey,
    });
  },

  async createRun(campaignId: string, clerkOrgId: string) {
    return callService(this.url, `/campaigns/${campaignId}/runs`, {
      method: "POST",
      apiKey: this.apiKey,
      clerkOrgId,
    });
  },

  async updateRun(runId: string, data: { status: "completed" | "failed" }) {
    return callService(this.url, `/runs/${runId}`, {
      method: "PATCH",
      body: data,
      apiKey: this.apiKey,
    });
  },

  async updateCampaign(campaignId: string, clerkOrgId: string, data: { brandId?: string; status?: "activate" | "stop" }) {
    return callService(this.url, `/campaigns/${campaignId}`, {
      method: "PATCH",
      body: data,
      apiKey: this.apiKey,
      clerkOrgId,
    });
  },

  async batchBudgetUsage(campaignIds: string[]) {
    return callService(this.url, "/campaigns/batch-budget-usage", {
      method: "POST",
      body: { campaignIds },
      apiKey: this.apiKey,
    }) as Promise<{
      results: Record<string, {
        status: string;
        maxLeads: number | null;
        maxBudgetTotalUsd: string | null;
        runs: { total: number; completed: number; failed: number; running: number };
        totalCostInUsdCents: string | null;
        error?: string;
      }>;
    }>;
  },
};

export const emailGenerationService = {
  url: process.env.EMAILGENERATION_SERVICE_URL || "http://localhost:3005",
  apiKey: process.env.EMAILGENERATION_SERVICE_API_KEY,
  
  async generate(clerkOrgId: string, data: unknown) {
    return callService(this.url, "/generate", {
      method: "POST",
      body: data,
      apiKey: this.apiKey,
      clerkOrgId,
    });
  },
};

export const postmarkService = {
  url: process.env.POSTMARK_SERVICE_URL || "https://postmark.mcpfactory.org",
  apiKey: process.env.POSTMARK_SERVICE_API_KEY,
  
  /**
   * Send an email via postmark-service
   */
  async send(data: {
    orgId: string;
    runId: string;
    brandId: string;
    appId: string;
    campaignId: string;
    from: string;
    to: string;
    subject: string;
    htmlBody?: string;
    textBody?: string;
    replyTo?: string;
    tag?: string;
    metadata?: Record<string, string>;
  }) {
    return callService(this.url, "/send", {
      method: "POST",
      body: data,
      apiKey: this.apiKey,
    });
  },
  
  /**
   * Get email status by message ID
   */
  async getStatus(messageId: string) {
    return callService(this.url, `/status/${messageId}`, {
      method: "GET",
      apiKey: this.apiKey,
    });
  },
  
  /**
   * Get emails by run
   */
  async getByRun(runId: string) {
    return callService(this.url, `/status/by-run/${runId}`, {
      method: "GET",
      apiKey: this.apiKey,
    });
  },
};

// Brand service - get sales profile for email personalization
export const brandService = {
  url: process.env.BRAND_SERVICE_URL || "https://brand.mcpfactory.org",
  apiKey: process.env.BRAND_SERVICE_API_KEY,

  /**
   * Get or extract sales profile for a brand
   * On first call, creates org and extracts profile
   * On subsequent calls, returns cached profile
   *
   * @param clerkOrgId - Clerk organization ID
   * @param brandUrl - Brand website URL
   * @param keyType - "byok" for user's key, "platform" for MCP Factory's key
   */
  async getSalesProfile(clerkOrgId: string, brandUrl: string, keyType: "byok" | "platform" = "byok", parentRunId?: string) {
    return callService(this.url, "/sales-profile", {
      method: "POST",
      body: {
        clerkOrgId,
        url: brandUrl,
        keyType,
        ...(parentRunId && { parentRunId }),
      },
      apiKey: this.apiKey,
    });
  },
};

// Lead Service - dedup + buffer service + Apollo search
export const leadService = {
  url: process.env.LEAD_SERVICE_URL || "http://localhost:3006",
  apiKey: process.env.LEAD_SERVICE_API_KEY,
  appId: "mcpfactory",

  headers(clerkOrgId: string) {
    return { "X-App-Id": this.appId, "X-Org-Id": clerkOrgId };
  },

  /**
   * Pull next lead from buffer. If buffer is empty and searchParams provided,
   * lead-service will auto-fetch from Apollo internally.
   */
  async next(
    clerkOrgId: string,
    params: {
      campaignId: string;
      brandId: string;
      parentRunId?: string;
      searchParams?: unknown;
      clerkUserId?: string;
    }
  ) {
    return callService(this.url, "/buffer/next", {
      method: "POST",
      body: params,
      apiKey: this.apiKey,
      extraHeaders: this.headers(clerkOrgId),
    });
  },

  async push(clerkOrgId: string, params: { campaignId: string; brandId: string; parentRunId?: string; clerkUserId?: string; leads: Array<{ email: string; externalId?: string; data?: unknown }> }) {
    return callService(this.url, "/buffer/push", {
      method: "POST",
      body: params,
      apiKey: this.apiKey,
      extraHeaders: this.headers(clerkOrgId),
    });
  },

  async getCursor(clerkOrgId: string, namespace: string) {
    return callService(this.url, `/cursor/${encodeURIComponent(namespace)}`, {
      method: "GET",
      apiKey: this.apiKey,
      extraHeaders: this.headers(clerkOrgId),
    });
  },

  async setCursor(clerkOrgId: string, namespace: string, state: unknown) {
    return callService(this.url, `/cursor/${encodeURIComponent(namespace)}`, {
      method: "PUT",
      body: { state },
      apiKey: this.apiKey,
      extraHeaders: this.headers(clerkOrgId),
    });
  },

  async getStats(clerkOrgId: string, params: { brandId?: string; campaignId?: string }) {
    const qs = new URLSearchParams();
    if (params.brandId) qs.set("brandId", params.brandId);
    if (params.campaignId) qs.set("campaignId", params.campaignId);
    return callService(this.url, `/stats?${qs.toString()}`, {
      method: "GET",
      apiKey: this.apiKey,
      extraHeaders: this.headers(clerkOrgId),
    }) as Promise<{ served: number; buffered: number; skipped: number }>;
  },
};

// Runs service - centralized run tracking and cost management
export const runsService = {
  ensureOrganization,
  createRun,
  updateRun: updateRunInService,
  addCosts,
  listRuns,
  getRun,
  getRunsBatch,
  getRunSummary,
};
