import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

test('hourly gross sales: today next to the same weekday last week, estimating gross for older net-only hours', async () => {
  const [a, b] = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 2').all().map((l) => l.id);
  const d = today();
  const lw = addDays(d, -7);
  db.prepare('DELETE FROM sales_hourly').run();
  db.prepare('DELETE FROM sales_daily').run();
  const hour = db.prepare('INSERT INTO sales_hourly (location_id, date, hour, net_sales, gross_sales, orders) VALUES (?, ?, ?, ?, ?, ?)');
  hour.run(a, d, 9, 100, 120, 1);
  hour.run(b, d, 9, 50, 60, 1);
  hour.run(a, d, 12, 200, 240, 1);
  hour.run(a, lw, 9, 100, null, 1); // synced before gross was kept per hour
  db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, tax, discounts, tips, orders) VALUES (?, ?, 100, 125, 25, 0, 0, 1)').run(a, lw);

  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const r = await (await fetch(`${base}/trading/hourly-compare`, { headers: { cookie } })).json();
  assert.equal(r.compare_date, lw);
  assert.deepEqual(r.hours.map((h) => [h.hour, h.today, h.last_week]), [[9, 180, 125], [10, 0, 0], [11, 0, 0], [12, 240, 0]]);

  const staff = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@cafe.local', password: DEMO_PASSWORD }) });
  assert.equal((await fetch(`${base}/trading/hourly-compare`, { headers: { cookie: staff.headers.get('set-cookie').split(';')[0] } })).status, 403);
});

test('the dashboard can show an earlier day in full, but not a future one', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = async (q) => fetch(`${base}/dashboard${q}`, { headers: { cookie } });
  const past = await (await get(`?date=${addDays(today(), -3)}`)).json();
  assert.equal(past.date, addDays(today(), -3));
  assert.equal(past.full_day, true);
  assert.equal(past.compare_date, addDays(today(), -10));
  assert.equal((await (await get('')).json()).full_day, false);
  assert.equal((await get(`?date=${addDays(today(), 1)}`)).status, 400);
});
