import { Redis } from "ioredis";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is not set");
    }
    console.log("[Sequential Job Worker][redis] Connecting to Redis...");
    redis = new Redis(url, {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
    });
    redis.on("connect", () => console.log("[Sequential Job Worker][redis] Connected"));
    redis.on("error", (err) => console.error("[Sequential Job Worker][redis] Error:", err.message));
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
