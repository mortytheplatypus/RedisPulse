# redis-pulse

## Layout

- `mock-services/` — Service A slow **weather** (`WEATHER_PORT`, default `4001`), B flaky **news** (`NEWS_PORT`, default `4002`), C rate-limited **currency** (`CURRENCY_PORT`, default `4003`)
- Data for random responses: [`mock-services/data/weather.csv`](mock-services/data/weather.csv), [`news.csv`](mock-services/data/news.csv), [`currency.csv`](mock-services/data/currency.csv)
- [`packages/core/`](packages/core/) — shared fetchers (`fetchWeather`, `fetchNews`, `fetchCurrency`), Redis key helpers, and **`data:` / `meta:` / `lock:`** operations
- `api-service/` — `GET /weather`, `GET /news`, `GET /currency` with **cache-aside**, **stale-while-revalidate**, **locks**, optional **queue** refresh, and **rate limiting**
- `worker/` — **BRPOP** on `queue:refresh`, refreshes per-service caches (run beside API when using queue mode)
- `infra/redis/` — Docker Compose + `redis.conf` for local Redis

## Service map

```text
Client
  |
  | HTTP
  v
api-service (Express, port 3000)
  |- GET /weather
  |- GET /news
  |- GET /currency
  |
  | Redis ops (cache/meta/locks/rate counters/queue)
  v
Redis
  ^
  | BRPOP/LPUSH queue:refresh
  |
worker
  |
  | Fetch upstream data
  v
mock-services
  |- weather-service (4001)
  |- news-service (4002)
  |- currency-service (4003)
```

## Setup

```bash
cd /path/to/redis-pulse
npm install
```

## Redis

Start Redis (see [`infra/redis/README.md`](infra/redis/README.md)):

```bash
npm run redis:up
export REDIS_URL=redis://127.0.0.1:6379
```

## Features

| Feature | Behavior |
|-------|----------|
| **SWR** | Per-service cache uses `data:{weather|news|currency}:...` + `meta:{weather|news|currency}:...` (`storedAt`). **Fresh** (age ≤ `STALE_AFTER_SECONDS`) → `X-Cache: HIT`. **Stale** (soft/hard window) → `X-Cache: STALE`, return cached value and refresh in background. **Hard-expired** age > `MAX_CACHE_SECONDS` → entry deleted, miss path. |
| **Lock** | Miss/refresh paths use Redis locks (`SET ... NX EX`) on `lock:{weather|news|currency}:...`. Waiters poll (`LOCK_WAIT_MS` / `LOCK_POLL_MS`) to avoid cache stampede. |
| **Queue** | Default **`USE_REFRESH_QUEUE=true`** (when Redis is enabled). API enqueues jobs with `LPUSH queue:refresh` and payload kind (`weather`, `news`, `currency`). Worker consumes with `BRPOP` and refreshes the matching key-space. |
| **Rate limit** | Fixed window **`INCR` + `EXPIRE`** per client IP. Middleware is applied to `/weather`, `/news`, and `/currency`. If Redis is disabled, requests bypass rate limiting. |

**Caching rule:** Single-service endpoints cache only successful upstream responses.

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
| `RATE_LIMIT_MAX` | `100` | Requests per window per IP (applies to `/weather`, `/news`, `/currency`) |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Fixed window length |

## Example requests

```bash
curl -s "http://127.0.0.1:3000/weather?location=Dhaka" | jq .
curl -s "http://127.0.0.1:3000/news?topic=tech" | jq .
curl -s "http://127.0.0.1:3000/currency?base=USD" | jq .

curl -s "http://127.0.0.1:4001/weather?location=Dhaka"
curl -s "http://127.0.0.1:4002/news?topic=tech"
curl -s "http://127.0.0.1:4003/currency?base=USD"
```

Upstream failures are not cached. For single-service endpoints, upstream errors are passed through with upstream status (or `502` fallback).
