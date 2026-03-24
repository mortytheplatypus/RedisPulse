# Code documentation (overview)

This document merges the **project intent** (requirements) with **how the repository is structured and behaves**, at a high level. For deep dives, see `docs/requirements.md` and `docs/api-behavior.md`.

---

## Goals

Build a **Redis-centric** layer in front of slow or unreliable upstreams so clients get **fast, stable** responses. The design should:

- Use Redis for more than a dumb key-value cache (cache metadata, locks, optional queue, rate limits).
- **Degrade gracefully** when Redis or upstreams are unavailable where the code allows it (for example, API can run without Redis in bypass mode).
- Handle **concurrency** so many clients hitting the same cold or expiring key do not all stampede upstream.

---

## Architecture (conceptual)

```text
Client → API (Express) → Redis (cache, locks, queue, rate counters)
              ↓                    ↑
         Mock / upstream      Worker (optional refresh consumer)
              services
```

Main code areas:

| Area | Role |
|------|------|
| `api-service/` | HTTP routes, orchestration, rate-limit middleware |
| `packages/core/` | Redis helpers (`data:` / `meta:` / `lock:`), HTTP fetchers, queue enqueue |
| `packages/worker/` | Long-running consumer: `BRPOP` on refresh queue, refresh + write cache |
| `mock-services/` | Standalone slow / flaky / rate-limited-ish backends for demos |

---

## Redis responsibilities (overview)

Redis holds:

1. **Cached responses**: paired `data:` + `meta:` keys (payload and `storedAt`).
2. **Distributed locks**: `lock:` keys so roughly **one** in-flight refresh/fetch per logical resource can own upstream work; others **wait or reuse** cached data.
3. **Refresh queue**: list `queue:refresh`; API can **enqueue** background refresh jobs; worker **pops** and executes them (alternative: refresh runs **inline** inside the API process when the queue mode is off).
4. **Rate limiting**: fixed-window counters per client IP when Redis is enabled on the API.

---

## HTTP API (as implemented)

One route per upstream family (see **`docs/requirements.md`** for the full spec):

| Route | Required query | Upstream |
|-------|----------------|----------|
| `GET /weather` | `location` | Weather mock (slow) |
| `GET /news` | `topic` | News mock (flaky) |
| `GET /currency` | `base` | Currency mock (rate-limited) |

`GET /health` checks liveness and Redis connectivity. Missing required query parameters yield **400**.

Responses carry **`cache`** (hit / stale / miss / bypass) and **`X-Cache`** for observability. **Bypass** means Redis was not used for that request (direct upstream).

---

## Request flow (mental model)

1. With Redis: read cache → classify age (**fresh** vs **stale** vs **expired** / **miss**).
2. **Fresh** → return from Redis (fast path).
3. **Stale** (still within hard window) → return cached body immediately, then **refresh in background** (queue **or** inline).
4. **Miss** → try to **take the lock**; if you win, fetch upstream and fill cache; if you lose, **poll** briefly for another request’s write, then retry or fall back to a direct fetch as coded.

Additional behaviors:

- **No Redis** → pass-through upstream, **bypass** semantics; IP rate limiting via Redis is skipped.
- **Rate limit** (when Redis is on) → may return **429** before the handler runs.

Only **successful, cacheable** upstream results are stored (failures are not normalized into long-lived “success” cache entries in the same way).

---

## Background refresh: queue vs inline

- **Queue mode**: After a **stale** response, the API pushes a small job to Redis; the **worker** blocks on `BRPOP`, runs the same style of lock → fetch → write as the API would inline.
- **Inline mode**: The API process schedules the refresh asynchronously without involving the worker queue.

The worker’s endless loop is intentional: **block until a job exists, handle one job, repeat** -- not a CPU spin.

---
