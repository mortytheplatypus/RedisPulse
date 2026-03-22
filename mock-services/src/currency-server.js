import express from "express";
import { createMinuteRateLimiter } from "./behaviors.js";
import { loadCsvFile } from "./csv.js";

const app = express();
const PORT = Number(process.env.CURRENCY_PORT ?? 4003);
const CURRENCY_MAX_PER_MINUTE = Number(process.env.CURRENCY_MAX_PER_MINUTE ?? 5);

const allowed = createMinuteRateLimiter(CURRENCY_MAX_PER_MINUTE);
const rows = loadCsvFile("../data/currency.csv");

app.get("/currency", (req, res) => {
  const base = (req.query.base ?? "USD").toString().toUpperCase();

  if (!allowed()) {
    res.set("Retry-After", "60");
    return res.status(429).json({
      error: "rate_limit_exceeded",
      message: `Limit ${CURRENCY_MAX_PER_MINUTE} requests per minute`,
    });
  }

  const pool = rows.filter((r) => r.base.toUpperCase() === base);
  const pick = pool.length ? pool : rows;
  const row = pick[Math.floor(Math.random() * pick.length)];

  res.json({
    base: row.base,
    rates: {
      EUR: Number(row.EUR),
      GBP: Number(row.GBP),
      BDT: Number(row.BDT),
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "currency" });
});

app.listen(PORT, () => {
  console.log(`currency mock listening on http://127.0.0.1:${PORT}`);
});
