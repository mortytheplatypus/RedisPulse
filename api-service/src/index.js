import express from "express";
import { serveAggregate } from "./aggregateHandler.js";
import { createRedisClient } from "./cache.js";
import { createAggregateRateLimiter } from "./rateLimit.js";

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.API_PORT ?? 3000);
const STALE_AFTER_SECONDS = Number(process.env.STALE_AFTER_SECONDS ?? 60);
const MAX_CACHE_SECONDS = Number(process.env.MAX_CACHE_SECONDS ?? 3600);
const LOCK_WAIT_MS = Number(process.env.LOCK_WAIT_MS ?? 2500);
const LOCK_POLL_MS = Number(process.env.LOCK_POLL_MS ?? 50);
const useRefreshQueue =
  process.env.USE_REFRESH_QUEUE !== "false" && process.env.USE_REFRESH_QUEUE !== "0";

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", "http://127.0.0.1:4001");
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", "http://127.0.0.1:4002");
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", "http://127.0.0.1:4003");

const redis = createRedisClient();

const aggregateCtx = {
  redis,
  staleAfterSeconds: STALE_AFTER_SECONDS,
  maxCacheSeconds: MAX_CACHE_SECONDS,
  lockWaitMs: LOCK_WAIT_MS,
  lockPollMs: LOCK_POLL_MS,
  useRefreshQueue: Boolean(redis) && useRefreshQueue,
  WEATHER_SERVICE_URL,
  NEWS_SERVICE_URL,
  CURRENCY_SERVICE_URL,
};

const rateLimitMw = createAggregateRateLimiter(redis, {});

app.get("/aggregate", rateLimitMw, async (req, res, next) => {
  try {
    await serveAggregate(req, res, aggregateCtx);
  } catch (e) {
    next(e);
  }
});

app.get("/health", async (_req, res) => {
  const cache = redis ? { redis: "configured" } : { redis: "disabled" };
  let redisOk = null;
  if (redis) {
    try {
      const pong = await redis.ping();
      redisOk = pong === "PONG";
    } catch {
      redisOk = false;
    }
  }
  res.json({ ok: true, ...cache, redisReachable: redisOk });
});

app.listen(PORT, () => {
  console.log(`api listening on http://127.0.0.1:${PORT}`);
  console.log(`WEATHER_SERVICE_URL=${WEATHER_SERVICE_URL}`);
  console.log(`NEWS_SERVICE_URL=${NEWS_SERVICE_URL}`);
  console.log(`CURRENCY_SERVICE_URL=${CURRENCY_SERVICE_URL}`);
  console.log(`REDIS_URL=${redis ? (process.env.REDIS_URL ?? "(set)") : "disabled"}`);
  console.log(`STALE_AFTER_SECONDS=${STALE_AFTER_SECONDS} MAX_CACHE_SECONDS=${MAX_CACHE_SECONDS}`);
  console.log(`USE_REFRESH_QUEUE=${aggregateCtx.useRefreshQueue}`);
});
