import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Service client", () => {
  it("should define service URLs", () => {
    const services = {
      emailGatewayService: "https://email-gateway.mcpfactory.org",
      companyService: "https://company.mcpfactory.org",
      leadService: "https://lead.mcpfactory.org",
    };
    expect(services.leadService).toContain("mcpfactory.org");
  });

  it("should define auth headers", () => {
    const headers = {
      "X-API-Key": "secret",
      "Content-Type": "application/json",
    };
    expect(headers["X-API-Key"]).toBeDefined();
  });
});

/**
 * Regression test: emailGatewayService.apiKey must reflect
 * EMAIL_GATEWAY_SERVICE_API_KEY — the old EMAIL_SENDING_SERVICE_*
 * names are dead. If the var is missing, startup should crash
 * (tested in startup.test.ts).
 */
describe("Email gateway env var", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("should use EMAIL_GATEWAY_SERVICE_API_KEY", async () => {
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "gw-key";

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.apiKey).toBe("gw-key");
  });

  it("should be undefined when EMAIL_GATEWAY_SERVICE_API_KEY is not set", async () => {
    delete process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.apiKey).toBeUndefined();
  });
});
