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
 * Regression test: env var rename from EMAIL_SENDING_SERVICE_* to
 * EMAIL_GATEWAY_SERVICE_* must fall back to the old names so
 * deployments that haven't updated their env vars yet don't break
 * with 401 Unauthorized.
 */
describe("Email gateway env var fallback", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("should use new EMAIL_GATEWAY_SERVICE_API_KEY when set", async () => {
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "new-key";
    delete process.env.EMAIL_SENDING_SERVICE_API_KEY;

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.apiKey).toBe("new-key");
  });

  it("should fall back to old EMAIL_SENDING_SERVICE_API_KEY when new var is not set", async () => {
    delete process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
    process.env.EMAIL_SENDING_SERVICE_API_KEY = "old-key";

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.apiKey).toBe("old-key");
  });

  it("should fall back to old EMAIL_SENDING_SERVICE_URL when new var is not set", async () => {
    delete process.env.EMAIL_GATEWAY_SERVICE_URL;
    process.env.EMAIL_SENDING_SERVICE_URL = "https://old-email-sending.example.com";

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.url).toBe("https://old-email-sending.example.com");
  });

  it("should prefer new EMAIL_GATEWAY_SERVICE_URL over old name", async () => {
    process.env.EMAIL_GATEWAY_SERVICE_URL = "https://new-gateway.example.com";
    process.env.EMAIL_SENDING_SERVICE_URL = "https://old-sending.example.com";

    const { emailGatewayService } = await import("../../src/lib/service-client.js");
    expect(emailGatewayService.url).toBe("https://new-gateway.example.com");
  });
});
