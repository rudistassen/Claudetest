import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bankHoliday } from '../src/bank-holidays.js';
import { openDb } from '../src/db.js';
import { salesForecast } from '../src/routes/rota.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

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

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

test('bank holidays are recognised', () => {
  assert.equal(bankHoliday('2026-12-28'), 'Boxing Day');
  assert.equal(bankHoliday('2026-04-06'), 'Easter Monday');
  assert.equal(bankHoliday('2026-04-07'), null);
});

test('sales forecast: each weekday’s average over the last weeks, leaving out bank holidays and closed days', () => {
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  db.prepare('DELETE FROM sales_daily WHERE location_id = ?').run(site);
  // A week in the past with a Monday bank holiday in the 8 weeks before it: Monday 31 August 2026.
  const ws = '2026-09-14';
  const put = (d, net) => db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (?, ?, ?, ?, 10)').run(site, d, net, net);
  put('2026-09-07', 1000); // Monday
  put('2026-08-31', 5000); // Monday, bank holiday – left out
  put('2026-08-24', 800); // Monday
  put('2026-09-12', 2000); // Saturday
  put('2026-09-13', 0); // Sunday, closed – left out
  put('2026-07-01', 9999); // Wednesday more than 8 weeks before – left out
  const f = salesForecast(db, [site], ws);
  assert.equal(f.to, '2026-09-13');
  assert.equal(f.from, addDays('2026-09-13', -55));
  assert.deepEqual(f.sites[site][0], { avg: 900, days: 2 }, 'Mondays: (1000 + 800) / 2');
  assert.deepEqual(f.sites[site][5], { avg: 2000, days: 1 });
  assert.equal(f.sites[site][6], null, 'no open Sundays');
  assert.equal(f.sites[site][2], null);
});

test('rota: forecast for managers only; publish one shift, one site, or one day', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = manager.me.location_id;
  const week = weekStart(today());
  const rota = (who, loc = site) => who(`/rota?location_id=${loc}&week=${week}`);
  assert.ok((await rota(manager)).data.forecast, 'managers see the forecast');
  assert.equal((await rota(staff)).data.forecast, undefined, 'staff don’t');

  const other = db.prepare('SELECT id FROM locations WHERE id != ? AND active = 1 ORDER BY id LIMIT 1').get(site).id;
  const person = db.prepare('SELECT id FROM users WHERE location_id = ? AND role = ? LIMIT 1').get(site, 'staff').id;
  const otherPerson = db.prepare('SELECT id FROM users WHERE location_id = ? AND role = ? LIMIT 1').get(other, 'staff').id;
  const day = addDays(week, 6);
  const add = (who, loc, user, start, end, d = day) => who('/shifts', { method: 'POST', body: { location_id: loc, user_id: user, date: d, start_time: start, end_time: end } });
  const a = await add(admin, site, person, '20:00', '22:00');
  const b = await add(admin, site, person, '22:30', '23:30');
  const c = await add(admin, other, otherPerson, '20:00', '22:00');
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
  const counts = (await rota(admin, 'all')).data;
  assert.equal(counts.unpublished_by_site[site], 2);
  assert.equal(counts.unpublished_by_site[other], 1);
  assert.equal(counts.unpublished_by_day[`${day}|${site}`], 2);

  // One shift.
  assert.equal((await staff(`/shifts/${a.data.id}/publish`, { method: 'POST' })).status, 403);
  assert.equal((await admin(`/shifts/${a.data.id}/publish`, { method: 'POST' })).status, 200);
  const seen = async () => (await staff(`/my-shifts?week=${week}`)).data.filter((x) => x.date === day && x.start_time >= '20:00').map((x) => x.start_time);
  if (staff.me.id === person) assert.deepEqual(await seen(), ['20:00'], 'only that shift is visible');
  // One site: the other site's change stays unpublished.
  assert.equal((await admin('/rota/publish', { method: 'POST', body: { location_id: site, week } })).data.published, 1);
  const after = (await rota(admin, 'all')).data;
  assert.equal(after.unpublished_by_site[site], undefined);
  assert.equal(after.unpublished_by_site[other], 1);
  // One day (all sites).
  const d = await add(admin, other, otherPerson, '18:00', '19:00', addDays(week, 5));
  assert.equal(d.status, 201);
  assert.equal((await admin('/rota/publish', { method: 'POST', body: { location_id: 'all', date: day } })).data.published, 1);
  assert.equal((await rota(admin, 'all')).data.unpublished_by_day[`${addDays(week, 5)}|${other}`], 1, 'other days untouched');
  // Publishing a removal deletes the shift.
  await admin(`/shifts/${d.data.id}`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE id = ?').get(d.data.id).n, 0, 'never-published shifts are simply deleted');
  await admin(`/shifts/${a.data.id}`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT removed FROM shifts WHERE id = ?').get(a.data.id).removed, 1);
  assert.deepEqual((await admin(`/shifts/${a.data.id}/publish`, { method: 'POST' })).data, { published: 1, removed: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE id = ?').get(a.data.id).n, 0);
});
