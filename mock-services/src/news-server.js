import express from "express";
import { pickRandomSubset, shouldFailNews } from "./behaviors.js";
import { loadCsvFile } from "./csv.js";

const app = express();
const PORT = Number(process.env.NEWS_PORT ?? 4002);

const rows = loadCsvFile("../data/news.csv");

app.get("/news", (req, res) => {
  const topic = (req.query.topic ?? "general").toString().trim();

  if (shouldFailNews()) {
    return res.status(500).json({
      error: "simulated_upstream_failure",
    });
  }

  const pool = rows.filter(
    (r) => r.topic.toLowerCase() === topic.toLowerCase()
  );
  const articles = pickRandomSubset(pool, 2).map((r) => ({
    title: r.title,
    link: r.link,
  }));

  res.json({
    topic,
    articles,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "news" });
});

app.listen(PORT, () => {
  console.log(`news mock listening on http://127.0.0.1:${PORT}`);
});
