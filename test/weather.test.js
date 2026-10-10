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
    } }) };
  };
  const get = londonWeather({ fetchFn });
  const days = await get();
  assert.deepEqual(days[0], { date: '2026-10-04', icon: '🌧️', label: 'Rain', max: 16, min: 8, rain: 80 });
  assert.equal(days[1].label, 'Sunny');
  await get();
  assert.equal(calls, 1, 'kept for an hour');
  assert.equal(describe(3).label, 'Cloudy');
  assert.equal(describe(999).label, '');
  const down = londonWeather({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(await down(), null, 'nothing to show rather than an error');
  up = false;
});
