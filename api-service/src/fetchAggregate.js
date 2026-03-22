/**
 * Fetches weather, news, and currency in parallel. Uses Promise.allSettled so one
 * failing backend still returns partial data with per-source status/error.
 */

export async function fetchAggregate({
  location,
  topic,
  base,
  WEATHER_SERVICE_URL,
  NEWS_SERVICE_URL,
  CURRENCY_SERVICE_URL,
}) {
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

  const body = {
    query: { location, topic, base },
    sources: {
      weather: settled[0].status === "fulfilled" ? "ok" : "error",
      news: settled[1].status === "fulfilled" ? "ok" : "error",
      currency: settled[2].status === "fulfilled" ? "ok" : "error",
    },
    data: parts,
    ...(Object.keys(errors).length ? { errors } : {}),
  };

  const allOk =
    settled[0].status === "fulfilled" &&
    settled[1].status === "fulfilled" &&
    settled[2].status === "fulfilled";

  return { statusCode, body, cacheable: allOk };
}
