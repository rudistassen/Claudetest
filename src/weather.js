// A simple 7-day forecast for London on the dashboard, from Open-Meteo (free, no account or key). Fetched on the
// server and kept for an hour, so opening the dashboard doesn't call the weather service each time.
const URL = 'https://api.open-meteo.com/v1/forecast?latitude=51.5072&longitude=-0.1276'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FLondon&forecast_days=7';
const KEEP_MS = 60 * 60 * 1000;

// WMO weather codes, as Open-Meteo reports them, in plain words.
const CODES = [
  [[0], '☀️', 'Sunny'], [[1], '🌤️', 'Mostly sunny'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'], [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 66, 80, 81], '🌧️', 'Rain'],
  [[65, 67, 82], '🌧️', 'Heavy rain'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'], [[95, 96, 99], '⛈️', 'Thunder'],
];
export const describe = (code) => {
  const hit = CODES.find(([codes]) => codes.includes(Number(code)));
  return hit ? { icon: hit[1], label: hit[2] } : { icon: '🌡️', label: '' };
};

/** The forecast: [{ date, icon, label, max, min, rain }], or null if the weather service can't be reached. */
export function londonWeather({ fetchFn = fetch } = {}) {
  let cache = { at: 0, days: null };
  return async () => {
    if (cache.days && Date.now() - cache.at < KEEP_MS) return cache.days;
    try {
      const res = await fetchFn(URL, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const d = (await res.json()).daily;
      const days = d.time.map((date, i) => ({
        date,
        ...describe(d.weather_code[i]),
        max: Math.round(d.temperature_2m_max[i]),
        min: Math.round(d.temperature_2m_min[i]),
        rain: d.precipitation_probability_max?.[i] ?? null,
      }));
      cache = { at: Date.now(), days };
      return days;
    } catch {
      // Keep showing the last forecast for a while if the service is briefly unavailable.
      return cache.days && Date.now() - cache.at < 6 * KEEP_MS ? cache.days : null;
    }
  };
}

export function registerWeatherRoutes(router, getWeather) {
  router.get('/weather', async (_req, res) => {
    const days = getWeather ? await getWeather() : null;
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.json({ place: 'London', days });
  });
}
