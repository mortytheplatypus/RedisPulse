import Redis from "ioredis";
import {
  QUEUE_REFRESH,
  acquireLock,
  fetchAggregate,
  releaseLock,
  writeAggregateEntry,
} from "@redis-pulse/core";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl || redisUrl === "false" || redisUrl === "0") {
  console.error("cache-worker: REDIS_URL is required");
  process.exit(1);
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", "http://127.0.0.1:4001");
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", "http://127.0.0.1:4002");
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", "http://127.0.0.1:4003");

async function processJob(job) {
  if (job.kind !== "aggregate") return;
  const { location, topic, base } = job;
  const token = await acquireLock(redis, location, topic, base);
  if (!token) {
    return;
  }
  try {
    const result = await fetchAggregate({
      location,
      topic,
      base,
      WEATHER_SERVICE_URL,
      NEWS_SERVICE_URL,
      CURRENCY_SERVICE_URL,
    });
    if (result.cacheable) {
      await writeAggregateEntry(redis, location, topic, base, {
        statusCode: result.statusCode,
        body: result.body,
      });
    }
  } finally {
    await releaseLock(redis, location, topic, base, token);
  }
}

async function main() {
  console.log(`cache-worker: blocking on ${QUEUE_REFRESH}`);
  console.log(`WEATHER_SERVICE_URL=${WEATHER_SERVICE_URL}`);
  // eslint-disable-next-line no-constant-condition -- BRPOP loop
  while (true) {
    const out = await redis.brpop(QUEUE_REFRESH, 0);
    if (!out) continue;
    const [, raw] = out;
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      continue;
    }
    try {
      await processJob(job);
    } catch (e) {
      console.warn("[worker] job failed:", e.message);
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
