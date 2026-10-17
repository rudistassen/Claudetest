import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, londonWeather } from '../src/weather.js';

test('London weather: 7 days from Open-Meteo, kept for an hour, last forecast kept if the service is down', async () => {
  let calls = 0;
  let up = true;
  const fetchFn = async (url) => {
    calls++;
    assert.match(url, /latitude=51\.5072&longitude=-0\.1276/);
    if (!up) throw new Error('offline');
    return { ok: true, json: async () => ({ daily: {
      time: ['2026-10-04', '2026-10-05'], weather_code: [61, 0], temperature_2m_max: [15.6, 18.2], temperature_2m_min: [8.4, 9.5], precipitation_probability_max: [80, 0],
    }, hourly: {
      // 4 Oct: windy 10am–3pm and again at 6pm (over 15 km/h) (the 3am gust doesn't count – the cafés are shut); 5 Oct: calm.
      time: [3, 10, 11, 12, 13, 14, 18, 19].map((h) => `2026-10-04T${String(h).padStart(2, '0')}:00`).concat(['2026-10-05T12:00']),
      wind_speed_10m: [40, 18, 22, 31.4, 25, 20, 21, 12, 15],
      wind_gusts_10m: [60, 30, 35, 44.6, 38, 30, 33, 20, 25],
    } }) };
  };
  const get = londonWeather({ fetchFn });
  const days = await get();
  assert.deepEqual(days[0], { date: '2026-10-04', icon: '🌧️', label: 'Rain', max: 16, min: 8, rain: 80, wind: { max: 31, gust: 45, spans: [[10, 15], [18, 19]] } });
  assert.equal(days[1].label, 'Sunny');
  assert.equal(days[1].wind, null, 'not windy enough to warn about');
  await get();
  assert.equal(calls, 1, 'kept for an hour');
  assert.equal(describe(3).label, 'Cloudy');
  assert.equal(describe(999).label, '');
  const down = londonWeather({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(await down(), null, 'nothing to show rather than an error');
  up = false;
});
