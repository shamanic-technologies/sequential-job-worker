import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for get-brand-sales-profile worker logic.
 *
 * Validates that:
 * - When profile fetch succeeds, clientData is built from profile
 * - When profile fetch fails, domain is used as fallback companyName
 * - brandId is always passed through (required input, not resolved from profile)
 */

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

interface GetBrandSalesProfileJobData {
  campaignId: string;
  runId: string;
  clerkOrgId: string;
  brandUrl: string;
  brandId: string;
  searchParams: Record<string, unknown>;
}

interface ClientData {
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
 * Extracted core logic from get-brand-sales-profile worker for testability.
 * Returns the clientData that would be passed to get-campaign-leads.
 */
async function resolveBrandProfile(
  jobData: GetBrandSalesProfileJobData,
  getSalesProfile: (clerkOrgId: string, brandUrl: string, keyType: string, runId: string) => Promise<SalesProfileResponse>,
): Promise<{ brandId: string; clientData: ClientData }> {
  const { clerkOrgId, brandUrl, brandId, runId } = jobData;
  const brandDomain = new URL(brandUrl).hostname.replace(/^www\./, "");

  let clientData: ClientData = { companyName: brandDomain, brandUrl };

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
    }
  } catch {
    // Profile fetch failed — use domain fallback, brandId is still valid
  }

  return { brandId, clientData };
}

describe("Get brand sales profile logic", () => {
  const baseJobData: GetBrandSalesProfileJobData = {
    campaignId: "camp-123",
    runId: "run-456",
    clerkOrgId: "org_abc",
    brandUrl: "https://growthservice.org",
    brandId: "brand-from-api",
    searchParams: { personTitles: ["VP Marketing"] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should build clientData from profile when fetch succeeds", async () => {
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

    expect(result.brandId).toBe("brand-from-api");
    expect(result.clientData.companyName).toBe("Growth Service");
    expect(result.clientData.keyFeatures).toEqual(["Feature A"]);
  });

  it("should use domain fallback when profile fetch fails", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(
      new Error("Service call failed: 502 - key service down")
    );

    const result = await resolveBrandProfile(baseJobData, getSalesProfile);

    expect(result.brandId).toBe("brand-from-api");
    expect(result.clientData.companyName).toBe("growthservice.org");
    expect(result.clientData.brandUrl).toBe("https://growthservice.org");
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

    expect(result.brandId).toBe("brand-from-api");
    expect(result.clientData.companyName).toBe("growthservice.org");
  });

  it("should strip www. from domain for fallback companyName", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(new Error("down"));

    const jobData = {
      ...baseJobData,
      brandUrl: "https://www.example.com",
    };
    const result = await resolveBrandProfile(jobData, getSalesProfile);

    expect(result.clientData.companyName).toBe("example.com");
  });

  it("should always pass through the input brandId regardless of profile response", async () => {
    const getSalesProfile = vi.fn().mockResolvedValue({
      cached: false,
      brandId: "different-brand-from-service",
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

    // Should use the brandId from job data, NOT from profile response
    expect(result.brandId).toBe("brand-from-api");
    expect(result.clientData.companyName).toBe("Acme Corp");
  });
});
