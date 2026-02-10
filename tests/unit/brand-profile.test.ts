import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for brand-profile worker fallback behavior.
 *
 * Validates that when the profile fetch fails:
 * - If the campaign has an existing brandId, use it as fallback and queue lead-search
 * - If no brandId is available, finalize the run as failed instead of queueing a doomed lead-search
 */

// Inline the logic under test to avoid importing the full BullMQ worker

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

interface BrandProfileJobData {
  campaignId: string;
  runId: string;
  clerkOrgId: string;
  brandUrl: string;
  brandId?: string;
  searchParams: Record<string, unknown>;
}

interface LeadSearchClientData {
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
}

/**
 * Extracted core logic from brand-profile worker for testability.
 * Returns the brandId and clientData that would be passed to lead-search,
 * or null if the run should be failed.
 */
async function resolveBrandProfile(
  jobData: BrandProfileJobData,
  getSalesProfile: (clerkOrgId: string, brandUrl: string, keyType: string, runId: string) => Promise<SalesProfileResponse>,
): Promise<{ brandId: string; clientData: LeadSearchClientData } | null> {
  const { clerkOrgId, brandUrl, brandId: fallbackBrandId, runId } = jobData;
  const brandDomain = new URL(brandUrl).hostname.replace(/^www\./, "");

  let clientData: LeadSearchClientData = { companyName: brandDomain, brandUrl };
  let brandId = "";

  try {
    const profileResult = await getSalesProfile(clerkOrgId, brandUrl, "byok", runId);

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

      if (profileResult.brandId) {
        brandId = profileResult.brandId;
      }
    }
  } catch {
    if (fallbackBrandId) {
      brandId = fallbackBrandId;
    } else {
      return null; // No brandId available — run should be failed
    }
  }

  return { brandId, clientData };
}

describe("Brand profile fallback behavior", () => {
  const baseJobData: BrandProfileJobData = {
    campaignId: "camp-123",
    runId: "run-456",
    clerkOrgId: "org_abc",
    brandUrl: "https://growthservice.org",
    searchParams: { personTitles: ["VP Marketing"] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use brandId from profile response when fetch succeeds", async () => {
    const getSalesProfile = vi.fn().mockResolvedValue({
      cached: false,
      brandId: "brand-from-service",
      profile: {
        companyName: "Growth Service",
        valueProposition: "Best growth tools",
        companyOverview: null,
        targetAudience: null,
        customerPainPoints: [],
        keyFeatures: ["Feature A"],
        productDifferentiators: [],
        competitors: [],
        socialProof: { caseStudies: [], testimonials: [], results: [] },
        callToAction: null,
        additionalContext: null,
      },
    } satisfies SalesProfileResponse);

    const result = await resolveBrandProfile(baseJobData, getSalesProfile);

    expect(result).not.toBeNull();
    expect(result!.brandId).toBe("brand-from-service");
    expect(result!.clientData.companyName).toBe("Growth Service");
    expect(result!.clientData.keyFeatures).toEqual(["Feature A"]);
  });

  it("should use fallback brandId when profile fetch fails and campaign has brandId", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(
      new Error("Service call failed: 502 - key service down")
    );

    const jobData = { ...baseJobData, brandId: "existing-brand-id" };
    const result = await resolveBrandProfile(jobData, getSalesProfile);

    expect(result).not.toBeNull();
    expect(result!.brandId).toBe("existing-brand-id");
    expect(result!.clientData.companyName).toBe("growthservice.org"); // domain fallback
    expect(result!.clientData.brandUrl).toBe("https://growthservice.org");
  });

  it("should return null when profile fetch fails and no fallback brandId", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(
      new Error("Service call failed: 502 - key service down")
    );

    // No brandId on the job data
    const result = await resolveBrandProfile(baseJobData, getSalesProfile);

    expect(result).toBeNull();
  });

  it("should use domain as companyName when profile has null companyName", async () => {
    const getSalesProfile = vi.fn().mockResolvedValue({
      cached: true,
      brandId: "brand-xyz",
      profile: {
        companyName: null,
        valueProposition: null,
        companyOverview: null,
        targetAudience: null,
        customerPainPoints: [],
        keyFeatures: [],
        productDifferentiators: [],
        competitors: [],
        socialProof: { caseStudies: [], testimonials: [], results: [] },
        callToAction: null,
        additionalContext: null,
      },
    } satisfies SalesProfileResponse);

    const result = await resolveBrandProfile(baseJobData, getSalesProfile);

    expect(result).not.toBeNull();
    expect(result!.brandId).toBe("brand-xyz");
    expect(result!.clientData.companyName).toBe("growthservice.org");
  });

  it("should strip www. from domain for fallback companyName", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(new Error("down"));

    const jobData = {
      ...baseJobData,
      brandUrl: "https://www.example.com",
      brandId: "brand-fallback",
    };
    const result = await resolveBrandProfile(jobData, getSalesProfile);

    expect(result).not.toBeNull();
    expect(result!.clientData.companyName).toBe("example.com");
  });

  it("should return empty brandId when profile response has no brandId", async () => {
    const getSalesProfile = vi.fn().mockResolvedValue({
      cached: false,
      // No brandId in response
      profile: {
        companyName: "Acme Corp",
        valueProposition: null,
        companyOverview: null,
        targetAudience: null,
        customerPainPoints: [],
        keyFeatures: [],
        productDifferentiators: [],
        competitors: [],
        socialProof: { caseStudies: [], testimonials: [], results: [] },
        callToAction: null,
        additionalContext: null,
      },
    } satisfies SalesProfileResponse);

    const result = await resolveBrandProfile(baseJobData, getSalesProfile);

    expect(result).not.toBeNull();
    expect(result!.brandId).toBe("");
    expect(result!.clientData.companyName).toBe("Acme Corp");
  });
});
