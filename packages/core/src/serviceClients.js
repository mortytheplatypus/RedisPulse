async function fetchJsonOrThrow(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, body });
  }
  return body;
}

export async function fetchWeather({ location, WEATHER_SERVICE_URL }) {
  const weatherUrl = `${WEATHER_SERVICE_URL}/weather?${new URLSearchParams({ location })}`;
  try {
    const body = await fetchJsonOrThrow(weatherUrl);
    return { statusCode: 200, body, cacheable: true };
  } catch (err) {
    return {
      statusCode: err?.status ?? 502,
      body: { error: err?.message ?? "upstream_error", detail: err?.body },
      cacheable: false,
    };
  }
}

export async function fetchNews({ topic, NEWS_SERVICE_URL }) {
  const newsUrl = `${NEWS_SERVICE_URL}/news?${new URLSearchParams({ topic })}`;
  try {
    const body = await fetchJsonOrThrow(newsUrl);
    return { statusCode: 200, body, cacheable: true };
  } catch (err) {
    return {
      statusCode: err?.status ?? 502,
      body: { error: err?.message ?? "upstream_error", detail: err?.body },
      cacheable: false,
    };
  }
}

export async function fetchCurrency({ base, CURRENCY_SERVICE_URL }) {
  const currencyUrl = `${CURRENCY_SERVICE_URL}/currency?${new URLSearchParams({ base })}`;
  try {
    const body = await fetchJsonOrThrow(currencyUrl);
    return { statusCode: 200, body, cacheable: true };
  } catch (err) {
    return {
      statusCode: err?.status ?? 502,
      body: { error: err?.message ?? "upstream_error", detail: err?.body },
      cacheable: false,
    };
  }
}
