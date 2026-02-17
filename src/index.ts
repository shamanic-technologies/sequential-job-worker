// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startCreateRunWorker } from "./workers/create-run.js";
import { startGetCampaignInfoWorker } from "./workers/get-campaign-info.js";
import { startGetBrandSalesProfileWorker } from "./workers/get-brand-sales-profile.js";
import { startGetCampaignLeadsWorker } from "./workers/get-campaign-leads.js";
import { startEmailGenerateWorker } from "./workers/email-generate.js";
import { startEmailSendWorker } from "./workers/email-send.js";
import { startEndRunWorker } from "./workers/end-run.js";
import { startCampaignScheduler, stopCampaignScheduler } from "./schedulers/campaign-scheduler.js";
import { closeRedis } from "./lib/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

console.log("[Sequential Job Worker] === MCP Factory Worker Starting ===");
console.log("[Sequential Job Worker] Environment check:");
console.log("[Sequential Job Worker]   REDIS_URL:", process.env.REDIS_URL ? "✓ configured" : "✗ MISSING");
console.log("[Sequential Job Worker]   CAMPAIGN_SERVICE_URL:", process.env.CAMPAIGN_SERVICE_URL || "✗ MISSING (using default: http://localhost:3003)");
console.log("[Sequential Job Worker]   BRAND_SERVICE_URL:", process.env.BRAND_SERVICE_URL ? "✓ configured" : "✗ MISSING");

// Fail fast if required env vars are missing — prevents crash-loop restarts
const requiredEnvVars = ["REDIS_URL", "EMAIL_GATEWAY_SERVICE_API_KEY"] as const;
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`[Sequential Job Worker] === FATAL: ${envVar} is required but not set ===`);
    process.exit(1);
  }
}

let schedulerInterval: NodeJS.Timeout;
let workers: ReturnType<typeof startCreateRunWorker>[] = [];

try {
  // Start the scheduler to poll for ongoing campaigns
  console.log("[Sequential Job Worker] Starting scheduler...");
  schedulerInterval = startCampaignScheduler(30000); // Every 30 seconds
  console.log("[Sequential Job Worker] Scheduler started");

  // Start all workers in the campaign run chain:
  // create-run → get-campaign-info → get-brand-sales-profile → get-campaign-leads → email-generate → email-send → end-run
  console.log("[Sequential Job Worker] Starting workers...");
  workers = [
    startCreateRunWorker(),            // Step 1: Create run in runs-service
    startGetCampaignInfoWorker(),      // Step 2: Fetch campaign details
    startGetBrandSalesProfileWorker(), // Step 3: Fetch sales profile from brand-service
    startGetCampaignLeadsWorker(),     // Step 4: Search leads via lead-service
    startEmailGenerateWorker(),        // Step 5: Generate emails
    startEmailSendWorker(),            // Step 6: Send emails
    startEndRunWorker(),               // Step 7: Finalize run, clean up, re-trigger
  ];
  console.log(`[Sequential Job Worker] === ${workers.length} workers + scheduler ready ===`);

  // Minimal HTTP server for health checks and /openapi.json
  const port = parseInt(process.env.PORT || "3000", 10);
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else if (req.method === "GET" && req.url === "/openapi.json") {
      if (existsSync(openapiPath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(readFileSync(openapiPath, "utf-8"));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
  server.listen(port, () => {
    console.log(`[Sequential Job Worker] OpenAPI spec available at http://localhost:${port}/openapi.json`);
  });
} catch (error) {
  console.error("[Sequential Job Worker] === FATAL: Worker startup failed ===", error);
  process.exit(1);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Sequential Job Worker] Shutting down workers...");

  stopCampaignScheduler();
  clearInterval(schedulerInterval);
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();

  console.log("[Sequential Job Worker] Workers shut down");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Sequential Job Worker] Shutting down workers...");

  stopCampaignScheduler();
  clearInterval(schedulerInterval);
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();

  console.log("[Sequential Job Worker] Workers shut down");
  process.exit(0);
});
