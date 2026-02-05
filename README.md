# Sequential Job Worker

A sequential job pipeline worker built on BullMQ and Redis. Processes chained jobs with rate limiting, budget enforcement, and run tracking.

## What is this?

A **Job Pipeline** — a chain of jobs that execute sequentially via Redis queues.

```
┌─────────────────────────────────────────────────────────────────┐
│  SCHEDULER (polls periodically)                                 │
│  "Are there tasks ready to run?"                                │
└─────────────────────┬───────────────────────────────────────────┘
                      │ YES → queue a job
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  REDIS QUEUES (BullMQ)                                          │
│                                                                 │
│  [step-1] → [step-2] → [step-3] → [step-4] → [step-5]          │
│      │          │          │          │          │              │
│      ▼          ▼          ▼          ▼          ▼              │
│   Worker 1   Worker 2   Worker 3   Worker 4   Worker 5          │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Sequential Pipeline**: Jobs chain together (Job A completes → queues Job B)
- **Fan-out Support**: One job can spawn multiple child jobs (1:N)
- **Rate Limiting**: Per-queue rate limits (e.g., 50/min for API calls)
- **Concurrency Control**: Configure workers per queue
- **Budget Enforcement**: Daily/weekly/monthly/total spend limits
- **Volume Gating**: Maximum items processed limits
- **Run Tracking**: Redis-backed job completion tracking
- **Stale Run Cleanup**: Auto-fail runs that exceed timeout
- **Graceful Shutdown**: Clean worker termination

## Architecture

```
src/
├── index.ts              # Entry point, starts all workers + scheduler
├── queues/
│   └── index.ts          # Queue definitions and job data types
├── workers/
│   ├── brand-upsert.ts   # Step 1: Initialize run
│   ├── brand-profile.ts  # Step 2: Fetch profile data
│   ├── lead-search.ts    # Step 3: Search for leads (fan-out)
│   ├── email-generate.ts # Step 4: Generate content
│   └── email-send.ts     # Step 5: Send output
├── schedulers/
│   └── campaign-scheduler.ts  # Polls for work, enforces budgets
└── lib/
    ├── redis.ts          # Redis connection
    ├── run-tracker.ts    # Job completion tracking
    ├── runs-client.ts    # Runs service HTTP client
    └── service-client.ts # External service clients
```

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your Redis URL and service endpoints

# Development
npm run dev

# Production
npm run build
npm start
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `REDIS_URL` | Redis connection string | Yes |
| `SENTRY_DSN` | Sentry error tracking | No |
| `*_SERVICE_URL` | Service endpoints | Yes |
| `*_SERVICE_API_KEY` | Service authentication | Yes |

## How Jobs Chain

Each worker processes a job and queues the next step:

```typescript
// In brand-upsert worker
const queues = getQueues();
await queues[QUEUE_NAMES.BRAND_PROFILE].add(
  `profile-${runId}`,
  { runId, campaignId, ... }
);
```

## Rate Limiting

Configure per-worker rate limits:

```typescript
const worker = new Worker(queueName, handler, {
  connection,
  concurrency: 10,
  limiter: {
    max: 50,
    duration: 60000, // 50 per minute
  },
});
```

## Budget Enforcement

The scheduler checks budget windows before queuing work:

- **Daily**: Resets at midnight
- **Weekly**: Rolling 7-day window
- **Monthly**: Resets on 1st of month
- **Total**: Lifetime cap (auto-stops when reached)

## License

MIT
