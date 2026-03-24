# API service: behavior report

This document explains what the **api-service** does end-to-end: routes, Redis-backed caching, stale-while-revalidate (SWR), locking, optional refresh queue, rate limiting, and how responses differ by scenario.

Implementation entrypoints:

- HTTP wiring: `api-service/src/index.js`
- Cache / upstream orchestration: `api-service/src/serviceHandler.js`
- Redis client: `api-service/src/cache.js`
- Rate limit middleware: `api-service/src/rateLimit.js`
- Shared Redis + HTTP primitives: `packages/core/` (`redisOps.js`, `serviceClients.js`)

---

## 1. Purpose

The API exposes three read-only endpoints that **proxy** to upstream mock services (weather, news, currency) while:

1. **Caching** successful responses in Redis per logical key (service kind + query parameter).
2. Serving **stale** cached data while refreshing in the background (SWR).
3. Using **distributed locks** so cache misses do not cause a thundering herd against upstream.
4. Optionally pushing refresh work to a **Redis list** consumed by a separate worker.
5. Applying a **fixed-window rate limit** per client IP when Redis is available.

---

## 2. HTTP surface

| Route       | Required query | Upstream (typical) |
|------------|----------------|--------------------|
| `GET /weather`  | `location` | Weather mock service |
| `GET /news`     | `topic`    | News mock service    |
| `GET /currency` | `base`     | Currency mock service |

- **Missing or blank** required parameter → **400** JSON: `{ "error": "missing_query_param", "param": "<name>" }`.
- **Health**: `GET /health` reports whether Redis is configured and (if configured) whether `PING` succeeds. This route does not use the cache handler.

Upstream base URLs are read from environment (with defaults from `default.js`) inside `serviceHandler.js` (`WEATHER_SERVICE_URL`, `NEWS_SERVICE_URL`, `CURRENCY_SERVICE_URL`).

---

## 3. Redis data model (per cache entry)

For each `(kind, paramValue)` the core package uses normalized keys (see `packages/core/src/redisOps.js`):

- **`data:{kind}:{paramValue}`** — JSON payload: `{ statusCode, body }` (what was returned to clients).
- **`meta:{kind}:{paramValue}`** — JSON metadata: `{ storedAt }` (epoch ms when the entry was written).
- **`lock:{kind}:{paramValue}`** — short-lived lock for coordinated miss handling / inline refresh (`SET NX EX` with token, released with compare-and-delete).

Normalization: weather/news query segments are lowercased; currency **`base`** is uppercased so keys are stable.

---

## 4. Classifying a cache entry (`classify`)

Given an entry (or absence of one) and `STALE_AFTER_SECONDS` / `MAX_CACHE_SECONDS`:

| State      | Meaning |
|-----------|---------|
| **miss**   | No entry, or entry was removed after **expired**. |
| **fresh**  | Age ≤ `STALE_AFTER_SECONDS`. |
| **stale**  | `STALE_AFTER_SECONDS` < age ≤ `MAX_CACHE_SECONDS`. |
| **expired**| Age > `MAX_CACHE_SECONDS` — entry is **deleted** and treated as **miss**. |

Age is always measured from `storedAt` to “now” at decision time.

---

## 5. Response shape and headers

Successful handler responses merge the upstream JSON **`body`** with a **`cache`** field:

- `cache`: `"hit"` | `"stale"` | `"miss"` | `"bypass"`
- Header **`X-Cache`**: `"HIT"` | `"STALE"` | `"MISS"` | `"BYPASS"` (mirrors the same idea)

Client errors (400 for missing param / unknown kind) are plain JSON **without** this cache envelope.

Rate limiting uses **429** with `{ "error": "rate_limit_exceeded" }` and `Retry-After` when Redis-backed limiting applies.

---

## 6. Scenario walkthrough (Redis **enabled**)

Assume `REDIS_URL` is set, Redis is reachable, and the required query param is present.

### 6.1 Fresh entry

1. Read `data:*` + `meta:*`, classify → **fresh**.
2. Respond immediately from cache: `cache: "hit"`, `X-Cache: HIT`.
3. No upstream call, no lock, no background refresh.

**Goal:** lowest latency and upstream load for “hot” keys.

### 6.2 Stale entry (stale-while-revalidate)

1. Classify → **stale** (past soft TTL, still within hard TTL).
2. **Return cached** response immediately: `cache: "stale"`, `X-Cache: STALE`.
3. **Refresh in background** via `triggerBackgroundRefresh`:
   - If **`shouldUseRefreshQueue`** is true (Redis + env): `LPUSH` a JSON job onto `queue:refresh` (worker refreshes later).
   - Else: fire-and-forget async path that tries to **acquire lock**, fetch upstream, **write** cache if `cacheable`, then **release lock**.

**Goal:** clients always get a fast answer; data is eventually refreshed.

### 6.3 Miss (no usable entry)

Typical path:

1. **`tryMissUnderLock`**: attempt to acquire `lock:{kind}:{paramValue}`.
   - If lock acquired: fetch upstream, **write** if `cacheable`, respond `miss` / `MISS`, release lock.
   - If lock **not** acquired: another client is probably filling the cache.

2. **`pollUntilServicePresent`**: poll until a **non-expired** entry appears or timeout (`LOCK_WAIT_MS`, `LOCK_POLL_MS`).

3. If polling returns an entry:
   - **Fresh** → respond `hit` / `HIT`.
   - **Stale** → same as 6.2 (stale response + background refresh).
   - Otherwise (e.g. still miss / expired) → continue.

4. **`tryMissUnderLock`** again (race: previous holder may have finished).

5. **`serveMissAfterLocks`**: fetch upstream (last resort), write if `cacheable`, respond `miss` / `MISS`.

**Goal:** only one concurrent upstream fetch per key under contention; waiters reuse the result when possible.

### 6.4 Caching rule

Only responses marked **`cacheable: true`** from the core fetchers are written to Redis. Upstream failures / non-cacheable outcomes are **not** stored as successful cache entries (see `packages/core/src/serviceClients.js` behavior for success vs error).

---

## 7. Scenario: Redis **disabled** (`REDIS_URL` unset / `false` / `0`)

1. No reads/writes to cache keys; no locks; no refresh queue from the API handler path.
2. Each request **calls upstream directly**; response uses `cache: "bypass"`, `X-Cache: BYPASS`.
3. **Rate limiting middleware** skips limiting when `redis` is null (`rateLimit.js`), so clients are not throttled via Redis in that mode.

**Goal:** local/dev or degraded operation without Redis.

---

## 8. Rate limiting (Redis **enabled**)

- Applied to `/weather`, `/news`, `/currency` before the handler runs.
- Fixed window per IP: `INCR` on `rate:api:{ip}:{window}` + `EXPIRE` on first increment.
- Limits come from `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SEC` (defaults in `default.js`).
- On exceed: **429**, `X-RateLimit-*` headers, `Retry-After`.
- If Redis errors during limit check, the middleware logs and **allows** the request (fail-open).

---

## 9. Background refresh queue vs inline

Controlled by **`shouldUseRefreshQueue`** in the request context (typically: Redis present **and** env such as `SHOULD_USE_REFRESH_QUEUE` per `.env.example` / `default.js`).

| Mode | Behavior |
|------|----------|
| **Queue** | API pushes `{ kind, location \| topic \| base }` to `queue:refresh`; a **worker** (`packages/worker`) `BRPOP`s and refreshes using the same lock + fetch + write pattern. |
| **Inline** | API process runs refresh in an async IIFE after returning stale data, still using locks to avoid duplicate fetches. |

---

## 10. Error and edge cases (summary)

| Situation | Typical outcome |
|-----------|------------------|
| Missing required query param | **400** `missing_query_param` |
| Internal `kind` not recognized (defensive) | **400** `unknown_kind` |
| Rate limit exceeded | **429** `rate_limit_exceeded` |
| Cached entry older than `MAX_CACHE_SECONDS` | Treated as expired → deleted → miss path |
| Lock held during miss | Wait/poll or second-chance lock; may still end in direct fetch |

---

## 11. Mental model 

```text
Request → rate limit (if Redis) → serveSingle
              │
              ├─ no Redis → upstream only → BYPASS
              │
              └─ Redis → read entry → classify
                        ├─ fresh  → HIT
                        ├─ stale  → STALE + background refresh (queue or inline)
                        └─ miss   → lock → fetch → write? → MISS
                                  → else poll → HIT or STALE or retry lock → final MISS path
```

---

