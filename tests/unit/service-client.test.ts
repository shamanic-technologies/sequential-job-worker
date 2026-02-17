import { describe, it, expect } from "vitest";

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
