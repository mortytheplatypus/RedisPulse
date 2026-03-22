# Redis (Docker)

## Start

From the repo root:

```bash
docker compose -f infra/redis/docker-compose.yml up -d
```

Or:

```bash
npm run redis:up
```

Stop:

```bash
docker compose -f infra/redis/docker-compose.yml down
```

Or `npm run redis:down` from the repo root.

## Connection

Default from the host:

```bash
export REDIS_URL=redis://127.0.0.1:6379
```

Disable caching (no Redis):

```bash
unset REDIS_URL
# or
export REDIS_URL=false
```

## Files

| File | Purpose |
|------|---------|
| [docker-compose.yml](docker-compose.yml) | `redis:7.0.10`, port `6379`, named volume for AOF data |
| [redis.conf](redis.conf) | `appendonly`, `maxmemory` + `allkeys-lru` |

Adjust memory or persistence in `redis.conf` as needed.
