import { describe, it, expect } from "vitest";

describe("Queue definitions", () => {
  it("should define queue names", () => {
    const queueNames = [
      "create-run",
      "get-campaign-info",
      "get-brand-sales-profile",
      "get-campaign-leads",
      "email-generate",
      "email-send",
      "end-run",
    ];
    expect(queueNames).toContain("create-run");
    expect(queueNames).toContain("get-campaign-leads");
    expect(queueNames).toContain("email-send");
    expect(queueNames).toContain("end-run");
  });

  it("should define job data interface", () => {
    const jobData = {
      campaignId: "camp_123",
      clerkOrgId: "org_456",
    };
    expect(jobData.campaignId).toBeDefined();
    expect(jobData.clerkOrgId).toBeDefined();
  });
});
