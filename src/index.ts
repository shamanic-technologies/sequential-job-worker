// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startBrandUpsertWorker } from "./workers/brand-upsert.js";
import { startBrandProfileWorker } from "./workers/brand-profile.js";
import { startLeadSearchWorker } from "./workers/lead-search.js";
import { startEmailGenerateWorker } from "./workers/email-generate.js";
import { startEmailSendWorker } from "./workers/email-send.js";
import { startCampaignScheduler, stopCampaignScheduler } from "./schedulers/campaign-scheduler.js";
import { closeRedis } from "./lib/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

console.log("[Sequential Job Worker] === MCP Factory Worker Starting ===");
console.log("[Sequential Job Worker] Environment check:");
console.log("[Sequential Job Worker]   REDIS_URL:", process.env.REDIS_URL ? "✓ configured" : "✗ MISSING");
console.log("[Sequential Job Worker]   CAMPAIGN_SERVICE_URL:", process.env.CAMPAIGN_SERVICE_URL ? "✓ configured" : "✗ MISSING");
console.log("[Sequential Job Worker]   BRAND_SERVICE_URL:", process.env.BRAND_SERVICE_URL ? "✓ configured" : "✗ MISSING");

let schedulerInterval: NodeJS.Timeout;
let workers: ReturnType<typeof startBrandUpsertWorker>[] = [];

try {
  // Start the scheduler to poll for ongoing campaigns
  console.log("[Sequential Job Worker] Starting scheduler...");
  schedulerInterval = startCampaignScheduler(30000); // Every 30 seconds
  console.log("[Sequential Job Worker] Scheduler started");

  // Start all workers in the campaign run chain:
  // brand-upsert (concurrency=1) → brand-profile → lead-search → email-generate → email-send
  console.log("[Sequential Job Worker] Starting workers...");
  workers = [
    startBrandUpsertWorker(),   // Step 1: Create run, get brand (non-concurrent)
    startBrandProfileWorker(),  // Step 2: Get sales profile from brand-service
    startLeadSearchWorker(),    // Step 3: Search leads via Apollo
    startEmailGenerateWorker(), // Step 4: Generate emails
    startEmailSendWorker(),     // Step 5: Send emails
  ];
  console.log(`[Sequential Job Worker] === ${workers.length} workers + scheduler ready ===`);

  // Minimal HTTP server to serve /openapi.json
  const port = parseInt(process.env.PORT || "3000", 10);
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/openapi.json") {
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
