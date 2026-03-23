import Redis from "ioredis";
import {
  QUEUE_REFRESH,
  acquireServiceLock,
  fetchCurrency,
  fetchNews,
  fetchWeather,
  releaseServiceLock,
  writeServiceEntry,
} from "@redis-pulse/core";
import { DEFAULTS } from "../../../default.js";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl || redisUrl === "false" || redisUrl === "0") {
  console.error("worker: REDIS_URL is required");
  process.exit(1);
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", DEFAULTS.WEATHER_SERVICE_URL);
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", DEFAULTS.NEWS_SERVICE_URL);
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", DEFAULTS.CURRENCY_SERVICE_URL);

async function processWeatherJob(job) {
  const location = job.location ?? "dhaka";
  const token = await acquireServiceLock(redis, "weather", location);
  if (!token) return;
  try {
    const result = await fetchWeather({ location, WEATHER_SERVICE_URL });
    if (result.cacheable) {
      await writeServiceEntry(redis, "weather", location, result);
    }
  } finally {
    await releaseServiceLock(redis, "weather", location, token);
  }
}

async function processNewsJob(job) {
  const topic = job.topic ?? "tech";
  const token = await acquireServiceLock(redis, "news", topic);
  if (!token) return;
  try {
    const result = await fetchNews({ topic, NEWS_SERVICE_URL });
    if (result.cacheable) {
      await writeServiceEntry(redis, "news", topic, result);
    }
  } finally {
    await releaseServiceLock(redis, "news", topic, token);
  }
}

async function processCurrencyJob(job) {
  const base = job.base ?? "USD";
  const token = await acquireServiceLock(redis, "currency", base);
  if (!token) return;
  try {
    const result = await fetchCurrency({ base, CURRENCY_SERVICE_URL });
    if (result.cacheable) {
      await writeServiceEntry(redis, "currency", base, result);
    }
  } finally {
    await releaseServiceLock(redis, "currency", base, token);
  }
}

async function processJob(job) {
  if (job.kind === "weather") return processWeatherJob(job);
  if (job.kind === "news") return processNewsJob(job);
  if (job.kind === "currency") return processCurrencyJob(job);
}

async function main() {
  console.log(`worker: blocking on ${QUEUE_REFRESH}`);
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
