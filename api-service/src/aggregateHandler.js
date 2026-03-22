import {
  acquireLock,
  deleteAggregateEntry,
  enqueueRefreshJob,
  fetchAggregate,
  pollUntilAggregatePresent,
  readAggregateEntry,
  releaseLock,
  writeAggregateEntry,
} from "@cache-project/core";

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

function respondToClassifiedWaited(res, waited, fetchCtx, redis, useRefreshQueue, staleAfterSeconds, maxCacheSeconds) {
  const st = classify(waited, Date.now(), staleAfterSeconds, maxCacheSeconds);
  if (st === "fresh") {
    jsonResponse(res, waited.statusCode, waited.body, "hit", "HIT");
    return true;
  }
  if (st === "stale") {
    triggerBackgroundRefresh(redis, fetchCtx, useRefreshQueue);
    jsonResponse(res, waited.statusCode, waited.body, "stale", "STALE");
    return true;
  }
  return false;
}

async function tryMissUnderLock(redis, fetchCtx, location, topic, base, res) {
  const token = await acquireLock(redis, location, topic, base);
  if (!token) return false;
  try {
    const { statusCode, body, cacheable } = await fetchAggregate(fetchCtx);
    if (cacheable) {
      await writeAggregateEntry(redis, location, topic, base, { statusCode, body });
    }
    jsonResponse(res, statusCode, body, "miss", "MISS");
    return true;
  } finally {
    await releaseLock(redis, location, topic, base, token);
  }
}

/**
 * Phase 3–5: SWR, locks, optional queue refresh.
 */
export async function serveAggregate(req, res, ctx) {
  const {
    redis,
    staleAfterSeconds,
    maxCacheSeconds,
    lockWaitMs,
    lockPollMs,
    useRefreshQueue,
    WEATHER_SERVICE_URL,
    NEWS_SERVICE_URL,
    CURRENCY_SERVICE_URL,
  } = ctx;

  const location = req.query.location ?? "dhaka";
  const topic = req.query.topic ?? "tech";
  const base = req.query.base ?? "USD";

  const fetchCtx = {
    location,
    topic,
    base,
    WEATHER_SERVICE_URL,
    NEWS_SERVICE_URL,
    CURRENCY_SERVICE_URL,
  };

  if (!redis) {
    const { statusCode, body } = await fetchAggregate(fetchCtx);
    return jsonResponse(res, statusCode, body, "bypass", "BYPASS");
  }

  const now = Date.now();
  let entry = await readAggregateEntry(redis, location, topic, base);
  let state = classify(entry, now, staleAfterSeconds, maxCacheSeconds);

  if (state === "expired") {
    await deleteAggregateEntry(redis, location, topic, base);
    entry = null;
    state = "miss";
  }

  if (state === "fresh") {
    return jsonResponse(res, entry.statusCode, entry.body, "hit", "HIT");
  }

  if (state === "stale") {
    triggerBackgroundRefresh(redis, fetchCtx, useRefreshQueue);
    return jsonResponse(res, entry.statusCode, entry.body, "stale", "STALE");
  }

  if (await tryMissUnderLock(redis, fetchCtx, location, topic, base, res)) {
    return;
  }

  const waited = await pollUntilAggregatePresent(
    redis,
    location,
    topic,
    base,
    lockWaitMs,
    lockPollMs,
    maxCacheSeconds
  );
  if (waited && respondToClassifiedWaited(res, waited, fetchCtx, redis, useRefreshQueue, staleAfterSeconds, maxCacheSeconds)) {
    return;
  }

  if (await tryMissUnderLock(redis, fetchCtx, location, topic, base, res)) {
    return;
  }

  const { statusCode, body, cacheable } = await fetchAggregate(fetchCtx);
  if (cacheable) {
    await writeAggregateEntry(redis, location, topic, base, { statusCode, body });
  }
  return jsonResponse(res, statusCode, body, "miss", "MISS");
}

function triggerBackgroundRefresh(redis, fetchCtx, useRefreshQueue) {
  const { location, topic, base } = fetchCtx;
  if (useRefreshQueue) {
    enqueueRefreshJob(redis, { kind: "aggregate", location, topic, base });
    return;
  }
  void (async () => {
    const t = await acquireLock(redis, location, topic, base);
    if (!t) return;
    try {
      const out = await fetchAggregate(fetchCtx);
      if (out.cacheable) {
        await writeAggregateEntry(redis, location, topic, base, {
          statusCode: out.statusCode,
          body: out.body,
        });
      }
    } finally {
      await releaseLock(redis, location, topic, base, t);
    }
  })();
}
