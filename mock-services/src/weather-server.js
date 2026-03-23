import express from "express";
import {
  randomDelayMs,
  sleep,
} from "./behaviors.js";
import { loadCsvFile } from "./csv.js";
import { DEFAULTS } from "../../default.js";

const app = express();
const PORT = Number(process.env.WEATHER_PORT ?? DEFAULTS.WEATHER_PORT);
const WEATHER_DELAY_MIN_MS = Number(process.env.WEATHER_DELAY_MIN_MS ?? DEFAULTS.WEATHER_DELAY_MIN_MS);
const WEATHER_DELAY_MAX_MS = Number(process.env.WEATHER_DELAY_MAX_MS ?? DEFAULTS.WEATHER_DELAY_MAX_MS);

const rows = loadCsvFile("../data/weather.csv");

app.get("/weather", async (req, res) => {
  const q = (req.query.location ?? "").toString().trim();
  await sleep(randomDelayMs(WEATHER_DELAY_MIN_MS, WEATHER_DELAY_MAX_MS));

  const match = q
    ? rows.filter(
        (r) => r.location.toLowerCase() === q.toLowerCase()
      )
    : [];
  const pool = match.length ? match : rows;
  const row = pool[Math.floor(Math.random() * pool.length)];

  res.json({
    location: row.location,
    temperature: Number(row.temperature),
    condition: row.condition,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "weather" });
});

app.listen(PORT, () => {
  console.log(`weather mock listening on http://127.0.0.1:${PORT}`);
});
