# RedisPulse

## Layout

- `mock-services/` — Service A slow **weather** (`WEATHER_PORT`, default `4001`), B flaky **news** (`NEWS_PORT`, default `4002`), C rate-limited **currency** (`CURRENCY_PORT`, default `4003`)
- Data for random responses: [`mock-services/data/weather.csv`](mock-services/data/weather.csv), [`news.csv`](mock-services/data/news.csv), [`currency.csv`](mock-services/data/currency.csv)
- `api-service/` — `GET /aggregate` calls all three in parallel (`Promise.allSettled`)

## Setup

```bash
cd /path/to/cache-project
npm install
```

## Run mocks (one command)

All three mocks (with file watch):

```bash
npm run dev:mock
```

Or without watch:

```bash
npm run start:mock
```

Individual processes (optional):

```bash
cd mock-services && npm run dev:weather   # port 4001
cd mock-services && npm run dev:news      # port 4002
cd mock-services && npm run dev:currency  # port 4003
```

## Run API

Start mocks first (see above), then the aggregation API in another terminal:

```bash
npm run dev:api
```

Without file watch:

```bash
npm run start:api
```

Defaults assume mocks on `4001`–`4003`. Override if needed:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEATHER_PORT` | `4001` | Port for weather mock (set `WEATHER_SERVICE_URL` to match if you change this) |
| `NEWS_PORT` | `4002` | Port for news mock |
| `CURRENCY_PORT` | `4003` | Port for currency mock |
| `WEATHER_SERVICE_URL` | `http://127.0.0.1:4001` | Weather mock base URL (used by `api-service`) |
| `NEWS_SERVICE_URL` | `http://127.0.0.1:4002` | News mock base URL |
| `CURRENCY_SERVICE_URL` | `http://127.0.0.1:4003` | Currency mock base URL |
| `API_PORT` | `3000` | Aggregation API |
| `WEATHER_DELAY_MIN_MS` / `WEATHER_DELAY_MAX_MS` | `1000` / `2000` | Service A delay |
| `CURRENCY_MAX_PER_MINUTE` | `5` | Successful `/currency` calls per UTC minute |

## Example responses (mocks)

**Weather** — random row from CSV (optionally filtered by `location`):

```json
{ "location": "Dhaka", "temperature": 32, "condition": "Sunny" }
```

**News** — two random articles for `topic` from CSV:

```json
{ "topic": "tech", "articles": [{ "title": "...", "link": "..." }, ...] }
```

**Currency** — random row for `base` from CSV:

```json
{ "base": "USD", "rates": { "EUR": 0.92, "GBP": 0.78, "BDT": 107.5 } }
```

## Example requests

```bash
curl -s "http://127.0.0.1:3000/aggregate?location=Dhaka&topic=tech&base=USD" | jq .

curl -s "http://127.0.0.1:4001/weather?location=Dhaka"
curl -s "http://127.0.0.1:4002/news?topic=tech"
curl -s "http://127.0.0.1:4003/currency?base=USD"
```

Partial failures: if one upstream fails, the response is still **200** with `data` null for that key and an `errors` map; if **all** fail, status **502**.
