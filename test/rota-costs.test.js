import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
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

const close = (a, b) => assert.ok(Math.abs(a - b) < 0.05, `${a} ≈ ${b}`);

test('rota cost for the week against a 30% labour budget on forecast sales, by site and by day', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const week = weekStart(addDays(today(), 7));
  // Eight weeks of history: £1,000 every day, so each day's forecast is £1,000 and its budget £300.
  db.prepare('DELETE FROM sales_daily WHERE location_id = ?').run(site);
  const ins = db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (?, ?, 1000, 1200, 50)');
  for (let d = addDays(week, -56); d < week; d = addDays(d, 1)) ins.run(site, d);

  const r = (await manager(`/reports/rota-costs?week=${week}&location_id=${site}`)).data;
  assert.equal(r.target_pct, 30);
  assert.equal(r.sites.length, 1);
  const s = r.sites[0];
  for (const d of s.days) {
    if (d.bank_holiday) continue;
    assert.equal(d.forecast, 1000);
    assert.equal(d.budget, 300);
    close(d.difference, d.cost - 300);
  }
  close(s.cost, s.days.reduce((n, d) => n + d.cost, 0));
  close(s.budget, s.forecast * 0.3);
  close(s.difference, s.cost - s.budget);
  assert.equal(s.labour_pct, Math.round((s.cost / s.forecast) * 10000) / 100);
  close(r.totals.cost, s.cost);

  // A new, unpublished shift counts on the planned rota but not the published one.
  const person = db.prepare(`SELECT id, hourly_rate FROM users WHERE location_id = ? AND role = 'staff' AND active = 1 LIMIT 1`).get(site);
  const day = addDays(week, 6);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(person.id, day);
  assert.equal((await manager('/shifts', { method: 'POST', body: { location_id: site, user_id: person.id, date: day, start_time: '09:00', end_time: '13:00', break_minutes: 0 } })).status, 201);
  const planned = (await manager(`/reports/rota-costs?week=${week}&location_id=${site}`)).data;
  const live = (await manager(`/reports/rota-costs?week=${week}&location_id=${site}&published=1`)).data;
  close(planned.totals.cost - live.totals.cost, 4 * person.hourly_rate + (s.cost - live.totals.cost));
  assert.ok(planned.unpublished >= 1);
});

test('all sites for admins; staff can’t see it; managers only their own site', async () => {
  const admin = await login('admin@cafe.local');
  const all = (await admin('/reports/rota-costs')).data;
  assert.equal(all.sites.length, 7);
  close(all.totals.cost, all.sites.reduce((n, s) => n + s.cost, 0));
  close(all.days.reduce((n, d) => n + d.cost, 0), all.totals.cost);
  assert.equal((await (await login('staff1@cafe.local'))('/reports/rota-costs')).status, 403);
  const manager = await login('manager1@cafe.local');
  assert.equal((await manager('/reports/rota-costs')).data.sites.length, 1);
});

test('a sales budget for a day replaces the forecast on the rota and in rota costs', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const week = weekStart(addDays(today(), 21));
  db.prepare('DELETE FROM sales_daily WHERE location_id = ?').run(site);
  const ins = db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (?, ?, 1000, 1200, 50)');
  for (let d = addDays(today(), -56); d < today(); d = addDays(d, 1)) ins.run(site, d);

  const before = (await manager(`/sales-budgets?week=${week}`)).data;
  const mine = before.sites.find((x) => x.id === site);
  assert.deepEqual(mine.budget, [null, null, null, null, null, null, null]);
  assert.ok(mine.forecast.every((f) => f === null || f === 1000));

  // An event on the Saturday: budget £2,500 that day; the rest left to the forecast.
  const saturday = addDays(week, 5);
  const budget = [null, null, null, null, null, 2500, null];
  assert.equal((await manager('/sales-budgets', { method: 'PUT', body: { week, sites: [{ id: site, budget }] } })).status, 200);
  assert.deepEqual((await manager(`/sales-budgets?week=${week}`)).data.sites.find((x) => x.id === site).budget, budget);

  const r = (await manager(`/reports/rota-costs?week=${week}&location_id=${site}`)).data;
  const sat = r.sites[0].days.find((d) => d.date === saturday);
  assert.deepEqual([sat.forecast, sat.sales_budget, sat.budgeted, sat.budget], [1000, 2500, true, 750]);
  const mon = r.sites[0].days[0];
  if (!mon.bank_holiday) assert.deepEqual([mon.sales_budget, mon.budgeted], [1000, false], 'no budget: the forecast');
  assert.equal(r.totals.budgeted, true);

  const rota = (await manager(`/rota?week=${week}&location_id=${site}`)).data;
  assert.equal(rota.sales_budget[site][5], 2500);

  // Clearing it goes back to the forecast; staff can't see or set budgets.
  await manager('/sales-budgets', { method: 'PUT', body: { week, sites: [{ id: site, budget: [null, null, null, null, null, null, null] }] } });
  assert.equal((await manager(`/sales-budgets?week=${week}`)).data.sites.find((x) => x.id === site).budget[5], null);
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/sales-budgets?week=${week}`)).status, 403);
  assert.equal((await manager('/sales-budgets', { method: 'PUT', body: { week, sites: [{ id: site, budget: [1] }] } })).status, 400);
});
