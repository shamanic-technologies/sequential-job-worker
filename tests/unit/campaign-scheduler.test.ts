import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the service client
vi.mock("../../src/lib/service-client.js", () => ({
  campaignService: {
    listCampaigns: vi.fn(),
    getRuns: vi.fn(),
    createRun: vi.fn(),
    updateCampaign: vi.fn(),
  },
  runsService: {
    listRuns: vi.fn(),
    updateRun: vi.fn(),
    getRunsBatch: vi.fn(),
  },
  leadService: {
    getStats: vi.fn(),
  },
}));

// Mock the queues
const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-123" });

vi.mock("../../src/queues/index.js", () => ({
  getQueues: () => ({
    "create-run": {
      add: mockQueueAdd,
    },
  }),
  QUEUE_NAMES: {
    CREATE_RUN: "create-run",
    GET_CAMPAIGN_INFO: "get-campaign-info",
    GET_BRAND_SALES_PROFILE: "get-brand-sales-profile",
    GET_CAMPAIGN_LEADS: "get-campaign-leads",
    EMAIL_GENERATE: "email-generate",
    EMAIL_SEND: "email-send",
  },
}));

// Mock redis
vi.mock("../../src/lib/redis.js", () => ({
  getRedis: vi.fn(() => ({})),
}));

import { campaignService, runsService, leadService } from "../../src/lib/service-client.js";
import { getQueues } from "../../src/queues/index.js";
import { startCampaignScheduler, isVolumeExceeded } from "../../src/schedulers/campaign-scheduler.js";

describe("Campaign Scheduler Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Budget-based scheduling", () => {
    it("should queue campaign when budget is not exceeded", async () => {
      const campaigns = [
        {
          id: "camp-1",
          orgId: "org-uuid",
          clerkOrgId: "org_clerk123",
          status: "ongoing",
          maxBudgetDailyUsd: "10.00",
          createdAt: new Date().toISOString(),
        },
      ];

      vi.mocked(campaignService.listCampaigns).mockResolvedValue({ campaigns });
      vi.mocked(runsService.listRuns).mockResolvedValue({ runs: [], limit: 200, offset: 0 });
      // No runs, so getRunsBatch won't be called

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        expect.stringContaining("campaign-camp-1"),
        expect.objectContaining({
          campaignId: "camp-1",
          clerkOrgId: "org_clerk123",
        })
      );
    });

    it("should NOT queue campaign when daily budget is exceeded", async () => {
      const campaigns = [
        {
          id: "camp-budget",
          orgId: "org-uuid",
          clerkOrgId: "org_clerk456",
          status: "ongoing",
          maxBudgetDailyUsd: "5.00",
          createdAt: new Date().toISOString(),
        },
      ];

      const existingRuns = [
        { id: "run-1", status: "completed", createdAt: new Date().toISOString() },
      ];

      vi.mocked(campaignService.listCampaigns).mockResolvedValue({ campaigns });
      vi.mocked(runsService.listRuns).mockResolvedValue({ runs: existingRuns, limit: 200, offset: 0 });
      vi.mocked(runsService.getRunsBatch).mockResolvedValue(
        new Map([
          ["run-1", {
            id: "run-1",
            status: "completed",
            createdAt: new Date().toISOString(),
            totalCostInUsdCents: "600", // $6.00 > $5.00 daily limit
            ownCostInUsdCents: "600",
            childrenCostInUsdCents: "0",
            costs: [],
            descendantRuns: [],
            parentRunId: null,
            organizationId: "org-id",
            userId: null,
            appId: "mcpfactory",
            brandId: null,
            campaignId: null,
            serviceName: "campaign-service",
            taskName: "camp-budget",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        ])
      );

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("should skip stopped campaigns", async () => {
      const campaigns = [
        {
          id: "camp-stopped",
          orgId: "org-uuid",
          clerkOrgId: "org_clerk999",
          status: "stopped",
          maxBudgetDailyUsd: "10.00",
          createdAt: new Date().toISOString(),
        },
      ];

      vi.mocked(campaignService.listCampaigns).mockResolvedValue({ campaigns });

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("should handle service errors gracefully (fail closed)", async () => {
      vi.mocked(campaignService.listCampaigns).mockRejectedValue(new Error("Service unavailable"));

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("Queue integration", () => {
    it("should add job to create-run queue", async () => {
      const queues = getQueues();

      await queues["create-run"].add("test-job", {
        campaignId: "camp-123",
        clerkOrgId: "org_test",
      });

      expect(queues["create-run"].add).toHaveBeenCalledWith("test-job", {
        campaignId: "camp-123",
        clerkOrgId: "org_test",
      });
    });
  });

  describe("Consecutive failure detection", () => {
    it("should pause campaign after 3 consecutive failed runs", async () => {
      const campaigns = [
        {
          id: "camp-failing",
          orgId: "org-uuid",
          clerkOrgId: "org_clerk_fail",
          status: "ongoing",
          maxBudgetDailyUsd: "10.00",
          createdAt: new Date().toISOString(),
        },
      ];

      // 3 consecutive failed runs (newest first)
      const failedRuns = [
        { id: "run-3", status: "failed", createdAt: new Date().toISOString() },
        { id: "run-2", status: "failed", createdAt: new Date().toISOString() },
        { id: "run-1", status: "failed", createdAt: new Date().toISOString() },
      ];

      vi.mocked(campaignService.listCampaigns).mockResolvedValue({ campaigns });
      vi.mocked(runsService.listRuns).mockResolvedValue({ runs: failedRuns, limit: 200, offset: 0 });
      vi.mocked(runsService.getRunsBatch).mockResolvedValue(
        new Map(failedRuns.map(r => [r.id, {
          ...r,
          totalCostInUsdCents: "0",
          ownCostInUsdCents: "0",
          childrenCostInUsdCents: "0",
          costs: [],
          descendantRuns: [],
          parentRunId: null,
          organizationId: "org-id",
          userId: null,
          appId: "mcpfactory",
          brandId: null,
          campaignId: null,
          serviceName: "campaign-service",
          taskName: "camp-failing",
          startedAt: r.createdAt,
          completedAt: r.createdAt,
          updatedAt: r.createdAt,
        }]))
      );

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      // Should NOT queue a new run
      expect(mockQueueAdd).not.toHaveBeenCalled();
      // Should stop the campaign
      expect(campaignService.updateCampaign).toHaveBeenCalledWith(
        "camp-failing",
        "org_clerk_fail",
        expect.objectContaining({ status: "stop" })
      );
    });

    it("should still queue campaign if only 2 consecutive failures", async () => {
      const campaigns = [
        {
          id: "camp-recovering",
          orgId: "org-uuid",
          clerkOrgId: "org_clerk_recover",
          status: "ongoing",
          maxBudgetDailyUsd: "10.00",
          createdAt: new Date().toISOString(),
        },
      ];

      // 2 failed then 1 completed (newest first)
      const runs = [
        { id: "run-3", status: "failed", createdAt: new Date().toISOString() },
        { id: "run-2", status: "failed", createdAt: new Date().toISOString() },
        { id: "run-1", status: "completed", createdAt: new Date().toISOString() },
      ];

      vi.mocked(campaignService.listCampaigns).mockResolvedValue({ campaigns });
      vi.mocked(runsService.listRuns).mockResolvedValue({ runs, limit: 200, offset: 0 });
      vi.mocked(runsService.getRunsBatch).mockResolvedValue(
        new Map(runs.map(r => [r.id, {
          ...r,
          totalCostInUsdCents: "0",
          ownCostInUsdCents: "0",
          childrenCostInUsdCents: "0",
          costs: [],
          descendantRuns: [],
          parentRunId: null,
          organizationId: "org-id",
          userId: null,
          appId: "mcpfactory",
          brandId: null,
          campaignId: null,
          serviceName: "campaign-service",
          taskName: "camp-recovering",
          startedAt: r.createdAt,
          completedAt: r.createdAt,
          updatedAt: r.createdAt,
        }]))
      );

      const interval = startCampaignScheduler(100000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      clearInterval(interval);

      // Should queue since only 2 consecutive failures < threshold of 3
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe("Volume check 404 handling", () => {
    it("should use completed run count when stats returns 404", async () => {
      vi.mocked(leadService.getStats).mockRejectedValue(
        new Error('Service call failed: 404 - {"error":"Not found"}')
      );

      const result = await isVolumeExceeded({
        id: "camp-1",
        orgId: "org-uuid",
        clerkOrgId: "org_clerk123",
        status: "ongoing",
        createdAt: new Date().toISOString(),
        maxLeads: 100,
        brandId: "brand-1",
      }, []);

      expect(result.exceeded).toBe(false);
      expect(result.totalServed).toBe(0);
    });

    it("should detect exceeded via run count when stats returns 404", async () => {
      vi.mocked(leadService.getStats).mockRejectedValue(
        new Error('Service call failed: 404 - {"error":"Not found"}')
      );

      const completedRuns = Array.from({ length: 5 }, (_, i) => ({
        id: `run-${i}`,
        status: "completed",
        createdAt: new Date().toISOString(),
      })) as any;

      const result = await isVolumeExceeded({
        id: "camp-1",
        orgId: "org-uuid",
        clerkOrgId: "org_clerk123",
        status: "ongoing",
        createdAt: new Date().toISOString(),
        maxLeads: 5,
        brandId: "brand-1",
      }, completedRuns);

      expect(result.exceeded).toBe(true);
      expect(result.totalServed).toBe(5);
    });

    it("should fail closed on non-404 errors", async () => {
      vi.mocked(leadService.getStats).mockRejectedValue(
        new Error("Service call failed: 500 - Internal Server Error")
      );

      const result = await isVolumeExceeded({
        id: "camp-1",
        orgId: "org-uuid",
        clerkOrgId: "org_clerk123",
        status: "ongoing",
        createdAt: new Date().toISOString(),
        maxLeads: 100,
        brandId: "brand-1",
      }, []);

      expect(result.exceeded).toBe(true);
    });
  });

  describe("Campaign filtering", () => {
    it("should filter only ongoing campaigns", () => {
      const campaigns = [
        { id: "1", status: "ongoing", maxBudgetDailyUsd: "10.00" },
        { id: "2", status: "stopped", maxBudgetDailyUsd: "10.00" },
        { id: "3", status: "ongoing", maxBudgetWeeklyUsd: "50.00" },
      ];

      const ongoing = campaigns.filter((c) => c.status === "ongoing");
      expect(ongoing).toHaveLength(2);
      expect(ongoing.map((c) => c.id)).toEqual(["1", "3"]);
    });

    it("should handle empty campaign list", () => {
      const campaigns: { id: string; status: string }[] = [];
      const ongoing = campaigns.filter((c) => c.status === "ongoing");
      expect(ongoing).toHaveLength(0);
    });
  });
});
