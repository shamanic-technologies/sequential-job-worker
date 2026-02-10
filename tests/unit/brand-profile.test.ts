import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for brand-profile worker behavior.
 *
 * brand-service is the only source of brandId. If it's down, fail the run.
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

interface BrandProfileJobData {
  campaignId: string;
  runId: string;
  clerkOrgId: string;
  brandUrl: string;
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
 * or null if the run should be failed (profile fetch threw).
 */
async function resolveBrandProfile(
  jobData: BrandProfileJobData,
  getSalesProfile: (clerkOrgId: string, brandUrl: string, keyType: string, runId: string) => Promise<SalesProfileResponse>,
): Promise<{ brandId: string; clientData: LeadSearchClientData } | null> {
  const { clerkOrgId, brandUrl, runId } = jobData;
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
    // brand-service is the only source of brandId — no fallback
    return null;
  }

  return { brandId, clientData };
}

describe("Brand profile behavior", () => {
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

  it("should return null (fail run) when profile fetch fails", async () => {
    const getSalesProfile = vi.fn().mockRejectedValue(
      new Error("Service call failed: 502 - key service down")
    );

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

  it("should return empty brandId when profile response has no brandId field", async () => {
    const getSalesProfile = vi.fn().mockResolvedValue({
      cached: false,
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
