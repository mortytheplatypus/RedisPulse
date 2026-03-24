import {
  acquireServiceLock,
  deleteServiceEntry,
  enqueueRefreshJob,
  fetchCurrency,
  fetchNews,
  fetchWeather,
  pollUntilServicePresent,
  readServiceEntry,
  releaseServiceLock,
  writeServiceEntry,
} from "@redis-pulse/core";
import { DEFAULTS } from "../../default.js";

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", DEFAULTS.WEATHER_SERVICE_URL);
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", DEFAULTS.NEWS_SERVICE_URL);
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", DEFAULTS.CURRENCY_SERVICE_URL);

function classify(entry, nowMs, staleAfterSec, maxCacheSec) {
  if (!entry) return "miss";
  const ageSec = (nowMs - entry.storedAt) / 1000;
  if (ageSec > maxCacheSec) return "expired";
  if (ageSec <= staleAfterSec) return "fresh";
  return "stale";
}

function jsonResponse(res, statusCode, body, cache, xCache) {
  return res.status(statusCode).set("X-Cache", xCache).json({ ...body, cache });
}

function readRequiredParam(req, paramName) {
  let raw = req.query[paramName];
  if (Array.isArray(raw)) raw = raw[0];
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

async function fetchByKind(kind, paramValue) {
  if (kind === "weather") {
    return fetchWeather({ location: paramValue, WEATHER_SERVICE_URL });
  }
  if (kind === "news") {
    return fetchNews({ topic: paramValue, NEWS_SERVICE_URL });
  }
  if (kind === "currency") {
    return fetchCurrency({ base: paramValue, CURRENCY_SERVICE_URL });
  }
  return null;
}

function queuePayload(kind, paramValue) {
  if (kind === "weather") return { kind, location: paramValue };
  if (kind === "news") return { kind, topic: paramValue };
  if (kind === "currency") return { kind, base: paramValue };
  return null;
}

/**
 * Tries to serve a cache miss while holding a per-key lock.
 * Fetches fresh data, writes cache when allowed, and responds immediately.
 *
 * @param {import("ioredis").Redis} redis Redis client instance.
 * @param {"weather" | "news" | "currency"} kind Service kind to fetch.
 * @param {string} paramValue Required query param string; Redis key segment for this resource.
 * @param {import("express").Response} res Express response object.
 * @returns {Promise<boolean>} True when response was served under lock, otherwise false.
 */
async function tryMissUnderLock(redis, kind, paramValue, res) {
  const token = await acquireServiceLock(redis, kind, paramValue);
  if (!token) return false;
  try {
    const fetched = await fetchByKind(kind, paramValue);
    if (!fetched) {
      res.status(400).json({ error: "unknown_kind", kind });
      return true;
    }
    const { statusCode, body, cacheable } = fetched;
    if (cacheable) {
      await writeServiceEntry(redis, kind, paramValue, { statusCode, body });
    }
    jsonResponse(res, statusCode, body, "miss", "MISS");
    return true;
  } finally {
    await releaseServiceLock(redis, kind, paramValue, token);
  }
}

/**
 * Triggers asynchronous refresh for stale cache entries.
 * Uses queue-based refresh when enabled, otherwise runs best-effort in-process refresh.
 *
 * @param {import("ioredis").Redis} redis Redis client instance.
 * @param {"weather" | "news" | "currency"} kind Service kind to refresh.
 * @param {string} paramValue Required query param string; Redis key segment for this resource.
 * @param {boolean} shouldUseRefreshQueue Whether to enqueue refresh job instead of local refresh.
 * @returns {void}
 */
function triggerBackgroundRefresh(redis, kind, paramValue, shouldUseRefreshQueue) {
  if (shouldUseRefreshQueue) {
    const payload = queuePayload(kind, paramValue);
    if (payload) enqueueRefreshJob(redis, payload);
    return;
  }
  void (async () => {
    const t = await acquireServiceLock(redis, kind, paramValue);
    if (!t) return;
    try {
      const out = await fetchByKind(kind, paramValue);
      if (!out) return;
      if (out.cacheable) {
        await writeServiceEntry(redis, kind, paramValue, {
          statusCode: out.statusCode,
          body: out.body,
        });
      }
    } finally {
      await releaseServiceLock(redis, kind, paramValue, t);
    }
  })();
}

async function serveWithoutRedis(res, kind, paramValue) {
  const fetched = await fetchByKind(kind, paramValue);
  if (!fetched) {
    res.status(400).json({ error: "unknown_kind", kind });
    return;
  }
  jsonResponse(res, fetched.statusCode, fetched.body, "bypass", "BYPASS");
}

function tryRespondFromWaitedEntry(waited, ctx, kind, paramValue, res) {
  if (!waited) return false;
  const { redis, staleAfterSeconds, maxCacheSeconds, shouldUseRefreshQueue } = ctx;
  const waitedState = classify(waited, Date.now(), staleAfterSeconds, maxCacheSeconds);
  if (waitedState === "fresh") {
    jsonResponse(res, waited.statusCode, waited.body, "hit", "HIT");
    return true;
  }
  if (waitedState === "stale") {
    triggerBackgroundRefresh(redis, kind, paramValue, shouldUseRefreshQueue);
    jsonResponse(res, waited.statusCode, waited.body, "stale", "STALE");
    return true;
  }
  return false;
}

async function serveMissAfterLocks(redis, kind, paramValue, res) {
  const fetched = await fetchByKind(kind, paramValue);
  if (!fetched) {
    res.status(400).json({ error: "unknown_kind", kind });
    return;
  }
  const { statusCode, body, cacheable } = fetched;
  if (cacheable) {
    await writeServiceEntry(redis, kind, paramValue, { statusCode, body });
  }
  jsonResponse(res, statusCode, body, "miss", "MISS");
}

/**
 * Serves a single cache-backed endpoint with stale-while-revalidate behavior.
 * Handles bypass, hit, stale, lock-wait, and miss fallback flows.
 *
 * @param {import("express").Request} req Express request object.
 * @param {import("express").Response} res Express response object.
 * @param {object} ctx Request-scoped runtime dependencies and cache config.
 * @param {"weather" | "news" | "currency"} kind Service kind to serve.
 * @param {string} paramName Required query-string parameter name (`location`, `topic`, or `base`).
 * @returns {Promise<void>}
 */
async function serveSingle(req, res, ctx, kind, paramName) {
  const {
    redis,
    staleAfterSeconds,
    maxCacheSeconds,
    lockWaitMs,
    lockPollMs,
    shouldUseRefreshQueue,
  } = ctx;

  const paramValue = readRequiredParam(req, paramName);
  if (paramValue == null) {
    return res.status(400).json({ error: "missing_query_param", param: paramName });
  }

  if (!redis) {
    await serveWithoutRedis(res, kind, paramValue);
    return;
  }

  const now = Date.now();
  let entry = await readServiceEntry(redis, kind, paramValue);
  let state = classify(entry, now, staleAfterSeconds, maxCacheSeconds);

  if (state === "expired") {
    await deleteServiceEntry(redis, kind, paramValue);
    entry = null;
    state = "miss";
  }

  if (state === "fresh") {
    return jsonResponse(res, entry.statusCode, entry.body, "hit", "HIT");
  }

  if (state === "stale") {
    triggerBackgroundRefresh(redis, kind, paramValue, shouldUseRefreshQueue);
    return jsonResponse(res, entry.statusCode, entry.body, "stale", "STALE");
  }

  if (await tryMissUnderLock(redis, kind, paramValue, res)) {
    return;
  }

  const waited = await pollUntilServicePresent(redis, kind, paramValue, lockWaitMs, lockPollMs, maxCacheSeconds);
  if (tryRespondFromWaitedEntry(waited, ctx, kind, paramValue, res)) {
    return;
  }

  if (await tryMissUnderLock(redis, kind, paramValue, res)) {
    return;
  }

  await serveMissAfterLocks(redis, kind, paramValue, res);
}

export function serveWeather(req, res, ctx) {
  return serveSingle(req, res, ctx, "weather", "location");
}

export function serveNews(req, res, ctx) {
  return serveSingle(req, res, ctx, "news", "topic");
}

export function serveCurrency(req, res, ctx) {
  return serveSingle(req, res, ctx, "currency", "base");
}
