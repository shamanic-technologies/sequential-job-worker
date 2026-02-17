import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

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

/**
 * Regression test: brand-service /sales-profile now requires appId and
 * clerkUserId. Without these fields the call returns 400:
 *   {"fieldErrors":{"appId":["expected string, received undefined"],
 *                   "clerkUserId":["expected string, received undefined"]}}
 */
describe("brandService.getSalesProfile request body", () => {
  let fetchSpy: MockInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cached: true, brandId: "b1" }), { status: 200 }),
    );
    process.env.BRAND_SERVICE_URL = "https://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "test-key";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("should include appId and clerkUserId in the request body", async () => {
    const { brandService } = await import("../../src/lib/service-client.js");

    await brandService.getSalesProfile(
      "org_abc",
      "https://example.com",
      "byok",
      "run-1",
      "my-app",
      "user_123",
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.appId).toBe("my-app");
    expect(body.clerkUserId).toBe("user_123");
    expect(body.clerkOrgId).toBe("org_abc");
    expect(body.url).toBe("https://example.com");
  });

  it("should default appId to 'mcpfactory' and clerkUserId to 'system' when not provided", async () => {
    const { brandService } = await import("../../src/lib/service-client.js");

    await brandService.getSalesProfile("org_abc", "https://example.com");

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.appId).toBe("mcpfactory");
    expect(body.clerkUserId).toBe("system");
  });
});
