import express from "express";

const app = express();
const PORT = Number(process.env.API_PORT ?? 3000);

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

/** One process per mock: weather, news, currency (see mock-services package). */
const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", "http://127.0.0.1:4001");
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", "http://127.0.0.1:4002");
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", "http://127.0.0.1:4003");

/**
 * GET /aggregate
 * Fetches weather, news, and currency in parallel. Uses Promise.allSettled so one
 * failing backend still returns partial data with per-source status/error.
 */
app.get("/aggregate", async (req, res) => {
  const location = req.query.location ?? "dhaka";
  const topic = req.query.topic ?? "tech";
  const base = req.query.base ?? "USD";

  const weatherUrl = `${WEATHER_SERVICE_URL}/weather?${new URLSearchParams({ location })}`;
  const newsUrl = `${NEWS_SERVICE_URL}/news?${new URLSearchParams({ topic })}`;
  const currencyUrl = `${CURRENCY_SERVICE_URL}/currency?${new URLSearchParams({ base })}`;

  const labels = ["weather", "news", "currency"];
  const settled = await Promise.allSettled([
    fetch(weatherUrl).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, body });
      return body;
    }),
    fetch(newsUrl).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, body });
      return body;
    }),
    fetch(currencyUrl).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, body });
      return body;
    }),
  ]);

  const parts = {};
  const errors = {};

  settled.forEach((result, i) => {
    const key = labels[i];
    if (result.status === "fulfilled") {
      parts[key] = result.value;
    } else {
      const err = result.reason;
      const status = err?.status ?? 502;
      const message = err?.message ?? String(err);
      errors[key] = { status, message, detail: err?.body };
      parts[key] = null;
    }
  });

  const allFailed = Object.keys(errors).length === 3;
  const statusCode = allFailed ? 502 : 200;

  res.status(statusCode).json({
    query: { location, topic, base },
    sources: {
      weather: settled[0].status === "fulfilled" ? "ok" : "error",
      news: settled[1].status === "fulfilled" ? "ok" : "error",
      currency: settled[2].status === "fulfilled" ? "ok" : "error",
    },
    data: parts,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`api listening on http://127.0.0.1:${PORT}`);
  console.log(`WEATHER_SERVICE_URL=${WEATHER_SERVICE_URL}`);
  console.log(`NEWS_SERVICE_URL=${NEWS_SERVICE_URL}`);
  console.log(`CURRENCY_SERVICE_URL=${CURRENCY_SERVICE_URL}`);
});
