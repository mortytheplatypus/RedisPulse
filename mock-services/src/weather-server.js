import express from "express";
import {
  randomDelayMs,
  sleep,
} from "./behaviors.js";
import { loadCsvFile } from "./csv.js";

const app = express();
const PORT = Number(process.env.WEATHER_PORT ?? 4001);
const WEATHER_DELAY_MIN_MS = Number(process.env.WEATHER_DELAY_MIN_MS ?? 1000);
const WEATHER_DELAY_MAX_MS = Number(process.env.WEATHER_DELAY_MAX_MS ?? 2000);

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
