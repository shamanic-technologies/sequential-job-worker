# Project: sequential-job-worker

A sequential job pipeline worker built on BullMQ and Redis. Processes chained campaign jobs (create run → get campaign info → get brand sales profile → get campaign leads → email generate → email send → end run) with rate limiting, budget enforcement, and run tracking.

## Commands

- `npm test` — run tests (Vitest)
- `npm run test:unit` — run unit tests only
- `npm run test:watch` — run tests in watch mode
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server (tsx watch)
- `npm run generate:openapi` — regenerate openapi.json
- `npm start` — start production server

## Architecture

- `src/index.ts` — Entry point: starts all workers, scheduler, and health-check HTTP server
- `src/instrument.ts` — Sentry initialization (must be imported first)
- `src/queues/index.ts` — BullMQ queue definitions and job data types
- `src/workers/` — One worker per pipeline step:
  - `create-run.ts` — Step 1: Create run in runs-service
  - `get-campaign-info.ts` — Step 2: Fetch campaign details (brandId, brandUrl, searchParams)
  - `get-brand-sales-profile.ts` — Step 3: Fetch sales profile from brand-service for email personalization
  - `get-campaign-leads.ts` — Step 4: Search leads via lead-service
  - `email-generate.ts` — Step 5: Generate email content
  - `email-send.ts` — Step 6: Send emails
  - `end-run.ts` — Step 7: Finalize run status, clean up tracking, re-trigger campaign
- `src/schedulers/campaign-scheduler.ts` — Polls for campaigns, enforces budgets/volume gates
- `src/lib/redis.ts` — Redis connection management
- `src/lib/run-tracker.ts` — Redis-backed job completion tracking
- `src/lib/runs-client.ts` — HTTP client for runs-service
- `src/lib/service-client.ts` — HTTP clients for external services
- `scripts/generate-openapi.ts` — OpenAPI spec generator
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
