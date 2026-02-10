# Project: sequential-job-worker

A sequential job pipeline worker built on BullMQ and Redis. Processes chained campaign jobs (brand upsert → brand profile → lead search → email generate → email send) with rate limiting, budget enforcement, and run tracking.

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
  - `brand-upsert.ts` — Step 1: Create run, initialize brand
  - `brand-profile.ts` — Step 2: Fetch sales profile from brand-service
  - `lead-search.ts` — Step 3: Search leads via Apollo (fan-out)
  - `email-generate.ts` — Step 4: Generate email content
  - `email-send.ts` — Step 5: Send emails
- `src/schedulers/campaign-scheduler.ts` — Polls for campaigns, enforces budgets/volume gates
- `src/lib/redis.ts` — Redis connection management
- `src/lib/run-tracker.ts` — Redis-backed job completion tracking
- `src/lib/runs-client.ts` — HTTP client for runs-service
- `src/lib/service-client.ts` — HTTP clients for external services
- `scripts/generate-openapi.ts` — OpenAPI spec generator
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
