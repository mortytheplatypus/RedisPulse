# Requirements (implemented)

This document describes **what this repository is built to do today**. It is aligned with the code under `api-service/`, `packages/core/`, `packages/worker/`, and `mock-services/`.

---

## 1. Objective

Provide a **Redis-backed API** in front of three **mock upstream** services so that:

- Responses are **fast** when data is cached.
- **Stale** data can still be served while refresh runs in the background.
- **Concurrent misses** on the same key do not all hit upstream at once (**stampede protection**).
- The system can run **without Redis** for development (direct upstream calls, no cache).

---

## 2. Components

| Component | Responsibility |
|-----------|----------------|
| **API** (`api-service/`) | Express app: routes, cache orchestration, optional rate limiting. |
| **Core** (`packages/core/`) | Redis keys/locks/queue helpers; HTTP clients to upstreams. |
| **Worker** (`packages/worker/`) | Consumes refresh jobs from Redis and updates cache. |
| **Mock services** (`mock-services/`) | Weather (slow), news (random failures), currency (per-minute cap). |
| **Redis** (`infra/redis/`) | Optional runtime; Docker Compose helper for local Redis. |

---

## 3. Functional requirements

### 3.1 API endpoints

| Method & path | Query | Behavior |
|---------------|--------|----------|
| `GET /weather` | `location` (required, non-empty) | Proxy to weather mock with caching. |
| `GET /news` | `topic` (required, non-empty) | Proxy to news mock with caching. |
| `GET /currency` | `base` (required, non-empty) | Proxy to currency mock with caching. |
| `GET /health` | — | JSON: API ok, Redis configured or disabled, `PING` result if Redis is used. |

**Validation**

- Missing or blank required query parameter → **400** with `missing_query_param`.

**Response semantics**

- Successful proxied JSON includes a `cache` field: `hit` | `stale` | `miss` | `bypass`.
- Matching `X-Cache` response header.
- **Bypass**: `REDIS_URL` unset/disabled → no cache; upstream only.

**Rate limiting** (only when Redis is configured for the API)

- Fixed window per client IP on `/weather`, `/news`, `/currency`.
- Over limit → **429** with `rate_limit_exceeded`.

### 3.2 Caching and freshness

- **Cache-aside**: read `data:` + `meta:`; on success path after upstream fetch, write when the response is **cacheable** (successful upstream semantics in core fetchers).
- **Fresh**: entry age ≤ `STALE_AFTER_SECONDS` → serve from Redis (`hit`).
- **Stale**: age between `STALE_AFTER_SECONDS` and `MAX_CACHE_SECONDS` → serve cached body (`stale`), trigger background refresh.
- **Expired**: age > `MAX_CACHE_SECONDS` → delete entry, treat as miss.

Tuning via environment (see `.env.example` and `default.js`).

### 3.3 Concurrency (stampede)

- Per `(service kind, normalized param)` a **Redis lock** (`SET NX` with TTL) ensures only one holder fetches to fill cache on miss paths used by the API.
- Waiters **poll** Redis for a valid entry within `LOCK_WAIT_MS` / `LOCK_POLL_MS` before retrying lock or last-resort fetch (as implemented in `serviceHandler.js` and `pollUntilServicePresent`).

### 3.4 Background refresh

Two modes (API + Redis required for queue path):

| Mode | Behavior |
|------|-----------|
| **Queue** | API pushes JSON jobs to `queue:refresh` (`LPUSH`). Worker **blocks** on `BRPOP`, runs lock → fetch → write for the job’s kind/param. |
| **Inline** | API schedules the same style of refresh **inside the API process** (no worker needed for that refresh). |

Controlled by **`SHOULD_USE_REFRESH_QUEUE`** together with Redis being enabled (`Boolean(redis) && …` in the API).

### 3.5 Mock upstreams

| Service | Port (default) | Simulated behavior |
|---------|----------------|--------------------|
| Weather | 4001 | Random delay between configured min/max ms before response. |
| News | 4002 | Random simulated **500** failures (`behaviors.js`). |
| Currency | 4003 | **429** after N requests per minute per mock process. |

Data: CSV files under `mock-services/data/`. Each mock exposes its own `/health`.

### 3.6 Redis key layout (conceptual)

- `data:{kind}:{param}` — cached `{ statusCode, body }`
- `meta:{kind}:{param}` — `{ storedAt }`
- `lock:{kind}:{param}` — distributed lock token
- `queue:refresh` — refresh job list (worker consumes)
- `rate:api:{ip}:{window}` — API rate limit counter

Normalization (e.g. case for `location` / `topic` / `base`) is defined in `packages/core/src/redisOps.js`.

---

## 4. Non-functional behavior (as built)

- **Degradation**: No Redis → API still serves data from upstreams (`bypass`); rate-limit middleware does not apply Redis-backed limits.
- **Rate-limit errors**: If Redis errors during increment, middleware **fails open** (request continues).
- **Observability**: `cache` + `X-Cache` on successful handler responses; structured logs on some Redis failures in core.

---

## 5. Configuration reference

See **`.env.example`** for variable names. Shared defaults live in **`default.js`**.

---

## 6. Related docs

- **`docs/summary.md`** — Short overview combining intent and structure.
- **`docs/api-behavior.md`** — Detailed request scenarios and behavior.
- **`README.md`** — How to run mocks, API, worker, and Redis locally.
