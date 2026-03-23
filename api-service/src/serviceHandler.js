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

function fetchByKind(kind, query, ctx) {
  if (kind === "weather") {
    return fetchWeather({ location: query, WEATHER_SERVICE_URL: ctx.WEATHER_SERVICE_URL });
  }
  if (kind === "news") {
    return fetchNews({ topic: query, NEWS_SERVICE_URL: ctx.NEWS_SERVICE_URL });
  }
  return fetchCurrency({ base: query, CURRENCY_SERVICE_URL: ctx.CURRENCY_SERVICE_URL });
}

function queuePayload(kind, query) {
  if (kind === "weather") return { kind, location: query };
  if (kind === "news") return { kind, topic: query };
  return { kind, base: query };
}

async function tryMissUnderLock(redis, kind, query, ctx, res) {
  const token = await acquireServiceLock(redis, kind, query);
  if (!token) return false;
  try {
    const { statusCode, body, cacheable } = await fetchByKind(kind, query, ctx);
    if (cacheable) {
      await writeServiceEntry(redis, kind, query, { statusCode, body });
    }
    jsonResponse(res, statusCode, body, "miss", "MISS");
    return true;
  } finally {
    await releaseServiceLock(redis, kind, query, token);
  }
}

function triggerBackgroundRefresh(redis, kind, query, ctx, useRefreshQueue) {
  if (useRefreshQueue) {
    enqueueRefreshJob(redis, queuePayload(kind, query));
    return;
  }
  void (async () => {
    const t = await acquireServiceLock(redis, kind, query);
    if (!t) return;
    try {
      const out = await fetchByKind(kind, query, ctx);
      if (out.cacheable) {
        await writeServiceEntry(redis, kind, query, {
          statusCode: out.statusCode,
          body: out.body,
        });
      }
    } finally {
      await releaseServiceLock(redis, kind, query, t);
    }
  })();
}

async function serveSingle(req, res, ctx, kind, queryParam, fallbackValue) {
  const {
    redis,
    staleAfterSeconds,
    maxCacheSeconds,
    lockWaitMs,
    lockPollMs,
    useRefreshQueue,
  } = ctx;

  const query = req.query[queryParam] ?? fallbackValue;

  if (!redis) {
    const { statusCode, body } = await fetchByKind(kind, query, ctx);
    return jsonResponse(res, statusCode, body, "bypass", "BYPASS");
  }

  const now = Date.now();
  let entry = await readServiceEntry(redis, kind, query);
  let state = classify(entry, now, staleAfterSeconds, maxCacheSeconds);

  if (state === "expired") {
    await deleteServiceEntry(redis, kind, query);
    entry = null;
    state = "miss";
  }

  if (state === "fresh") {
    return jsonResponse(res, entry.statusCode, entry.body, "hit", "HIT");
  }

  if (state === "stale") {
    triggerBackgroundRefresh(redis, kind, query, ctx, useRefreshQueue);
    return jsonResponse(res, entry.statusCode, entry.body, "stale", "STALE");
  }

  if (await tryMissUnderLock(redis, kind, query, ctx, res)) {
    return;
  }

  const waited = await pollUntilServicePresent(redis, kind, query, lockWaitMs, lockPollMs, maxCacheSeconds);
  if (waited) {
    const waitedState = classify(waited, Date.now(), staleAfterSeconds, maxCacheSeconds);
    if (waitedState === "fresh") {
      jsonResponse(res, waited.statusCode, waited.body, "hit", "HIT");
      return;
    }
    if (waitedState === "stale") {
      triggerBackgroundRefresh(redis, kind, query, ctx, useRefreshQueue);
      jsonResponse(res, waited.statusCode, waited.body, "stale", "STALE");
      return;
    }
  }

  if (await tryMissUnderLock(redis, kind, query, ctx, res)) {
    return;
  }

  const { statusCode, body, cacheable } = await fetchByKind(kind, query, ctx);
  if (cacheable) {
    await writeServiceEntry(redis, kind, query, { statusCode, body });
  }
  return jsonResponse(res, statusCode, body, "miss", "MISS");
}

export function serveWeather(req, res, ctx) {
  return serveSingle(req, res, ctx, "weather", "location", "dhaka");
}

export function serveNews(req, res, ctx) {
  return serveSingle(req, res, ctx, "news", "topic", "tech");
}

export function serveCurrency(req, res, ctx) {
  return serveSingle(req, res, ctx, "currency", "base", "USD");
}
