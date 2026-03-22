# RedisPulse

## Layout

- `mock-services/` — Service A slow **weather** (`WEATHER_PORT`, default `4001`), B flaky **news** (`NEWS_PORT`, default `4002`), C rate-limited **currency** (`CURRENCY_PORT`, default `4003`)
- Data for random responses: [`mock-services/data/weather.csv`](mock-services/data/weather.csv), [`news.csv`](mock-services/data/news.csv), [`currency.csv`](mock-services/data/currency.csv)
- [`packages/core/`](packages/core/) — shared **`fetchAggregate`**, Redis key helpers, **`data:` / `meta:` / `lock:`** operations, **`queue:refresh`** enqueue
- `api-service/` — `GET /aggregate` with **cache-aside**, **stale-while-revalidate**, **locks**, optional **queue** refresh, **rate limiting**
- `worker/` — **BRPOP** on `queue:refresh`, refreshes aggregate cache (run beside API when using queue mode)
- `infra/redis/` — Docker Compose + `redis.conf` for local Redis

## Setup

```bash
cd /path/to/cache-project
npm install
```

## Redis

Start Redis (see [`infra/redis/README.md`](infra/redis/README.md)):

```bash
npm run redis:up
export REDIS_URL=redis://127.0.0.1:6379
```

## Phases 3–6 (behavior)

| Phase | Behavior |
|-------|----------|
| **3 — SWR** | `data:aggregate:...` + `meta:aggregate:...` (`storedAt`). **Fresh** (age ≤ `STALE_AFTER_SECONDS`) → `X-Cache: HIT`. **Stale** (age between soft and hard max) → `X-Cache: STALE`, return cached JSON, **enqueue or inline refresh**. **Hard** age &gt; `MAX_CACHE_SECONDS` → entry deleted, miss path. |
| **4 — Lock** | On miss, **`SET lock:aggregate:... NX EX`**; waiters **poll** (`LOCK_WAIT_MS` / `LOCK_POLL_MS`) for another process to fill cache, then **retry lock** or fetch. Stale background refresh also uses the lock. |
| **5 — Queue** | Default **`USE_REFRESH_QUEUE`** (set to `false` to force **inline** refresh only). API **`LPUSH queue:refresh`** with `{ kind, location, topic, base }`. Run **`npm run dev:worker`** in another terminal. |
| **6 — Rate limit** | Fixed window **`INCR` + `EXPIRE`** on `rate:aggregate:{ip}:{window}`. **`429`** + `Retry-After` when over limit (requires Redis; skipped if Redis disabled). |

**Caching rule:** only **all-three-upstream success** responses are written to `data:`/`meta:`.

**Response:** `cache` is `hit` | `stale` | `miss` | `bypass` (no Redis).

## Run mocks

```bash
npm run dev:mock
```

## Run API

```bash
npm run dev:api
```

## Run worker (when `USE_REFRESH_QUEUE` is on)

Requires `REDIS_URL`, same mock URLs as the API:

```bash
export REDIS_URL=redis://127.0.0.1:6379
npm run dev:worker
```

## Environment (API)

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEATHER_SERVICE_URL` / `NEWS_SERVICE_URL` / `CURRENCY_SERVICE_URL` | `http://127.0.0.1:4001`–`4003` | Mock bases |
| `API_PORT` | `3000` | API listen port |
| `REDIS_URL` | _(unset)_ | `redis://...`; omit or `false` → no cache (`bypass`) |
| `STALE_AFTER_SECONDS` | `60` | Fresh vs stale (soft) |
| `MAX_CACHE_SECONDS` | `3600` | Drop entry if older (hard) |
| `LOCK_WAIT_MS` / `LOCK_POLL_MS` | `2500` / `50` | Stampede waiter poll |
| `LOCK_TTL_SECONDS` | `5` | Lock key TTL (`packages/core` / worker) |
| `USE_REFRESH_QUEUE` | `true` (if Redis) | `false` = inline refresh only |
| `RATE_LIMIT_MAX` | `100` | Requests per window per IP (`/aggregate`) |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Fixed window length |

## Example requests

```bash
curl -s "http://127.0.0.1:3000/aggregate?location=Dhaka&topic=tech&base=USD" | jq .

curl -s "http://127.0.0.1:4001/weather?location=Dhaka"
curl -s "http://127.0.0.1:4002/news?topic=tech"
curl -s "http://127.0.0.1:4003/currency?base=USD"
```

Partial upstream failures: response can still be **200** with `errors`; those responses are **not** cached.
