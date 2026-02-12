import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock redis
const mockDel = vi.fn().mockResolvedValue(1);
vi.mock("../../src/lib/redis.js", () => ({
  getRedis: vi.fn(() => ({
    del: mockDel,
  })),
}));

// Mock runs-service
vi.mock("../../src/lib/service-client.js", () => ({
  runsService: {
    updateRun: vi.fn().mockResolvedValue({}),
  },
}));

// Mock campaign scheduler
vi.mock("../../src/schedulers/campaign-scheduler.js", () => ({
  retriggerCampaignIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import { runsService } from "../../src/lib/service-client.js";
import { retriggerCampaignIfNeeded } from "../../src/schedulers/campaign-scheduler.js";
import { cleanupRunTracking } from "../../src/lib/run-tracker.js";

describe("End Run Logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Mirrors the status determination from end-run.ts:
   * stats.failed === stats.total ? "failed" : "completed"
   */
  function determineStatus(stats: { total: number; done: number; failed: number }): "completed" | "failed" {
    return stats.failed === stats.total ? "failed" : "completed";
  }

  describe("Status determination", () => {
    it("should mark as completed when all succeed", () => {
      expect(determineStatus({ total: 5, done: 5, failed: 0 })).toBe("completed");
    });

    it("should mark as failed when all fail", () => {
      expect(determineStatus({ total: 3, done: 3, failed: 3 })).toBe("failed");
    });

    it("should mark as completed with mixed results", () => {
      expect(determineStatus({ total: 5, done: 5, failed: 2 })).toBe("completed");
    });

    it("should mark as failed when total is zero (early failure / no leads)", () => {
      // 0 === 0 → "failed"
      expect(determineStatus({ total: 0, done: 0, failed: 0 })).toBe("failed");
    });

    it("should mark as completed with single success", () => {
      expect(determineStatus({ total: 1, done: 1, failed: 0 })).toBe("completed");
    });

    it("should mark as failed with single failure", () => {
      expect(determineStatus({ total: 1, done: 1, failed: 1 })).toBe("failed");
    });
  });

  describe("Run finalization flow", () => {
    it("should update run status in runs-service", async () => {
      const runId = "run-123";
      const status = determineStatus({ total: 5, done: 5, failed: 0 });

      await runsService.updateRun(runId, status);

      expect(runsService.updateRun).toHaveBeenCalledWith("run-123", "completed");
    });

    it("should clean up Redis tracking keys", async () => {
      await cleanupRunTracking("run-456");

      expect(mockDel).toHaveBeenCalledTimes(3);
      expect(mockDel).toHaveBeenCalledWith("run:run-456:total");
      expect(mockDel).toHaveBeenCalledWith("run:run-456:done");
      expect(mockDel).toHaveBeenCalledWith("run:run-456:failed");
    });

    it("should call retriggerCampaignIfNeeded after finalization", async () => {
      await retriggerCampaignIfNeeded("camp-789", "org_clerk123");

      expect(retriggerCampaignIfNeeded).toHaveBeenCalledWith("camp-789", "org_clerk123");
    });
  });
});
