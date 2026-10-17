import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { nowMinutes } from '../src/metrics.js';
import { addDays, today, zonedMidnightUTC } from '../src/util.js';

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
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();
  call.me = (await call('/auth/me')).user;
  return call;
}

test('dashboard site cards: gross, net and labour against the same time last week, and who clocked in', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const d = today();
  const lastWeek = addDays(d, -7);
  const person = db.prepare('SELECT id, name FROM users WHERE location_id = ? AND active = 1 LIMIT 1').get(site);
  db.prepare('DELETE FROM sales_daily WHERE location_id = ?').run(site);
  db.prepare('DELETE FROM sales_hourly WHERE location_id = ?').run(site);
  db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (?, ?, ?, ?, ?)').run(site, d, 500, 600, 40);
  // Last week: £100 net in the first hour of the day (already past by now) and £900 late in the evening.
  db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (?, ?, ?, ?, ?)').run(site, lastWeek, 1000, 1200, 80);
  db.prepare('INSERT INTO sales_hourly (location_id, date, hour, net_sales, orders) VALUES (?, ?, 0, 100, 8), (?, ?, 23, 900, 72)').run(site, lastWeek, site, lastWeek);
  const start = Date.parse(zonedMidnightUTC(d));
  db.prepare(`INSERT INTO timecards (id, location_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status)
    VALUES ('tc-dash', ?, ?, ?, ?, ?, 0, 12, 'CLOSED')`).run(site, person.id, d, new Date(start).toISOString(), new Date(start + 30 * 60000).toISOString());

  const data = await manager('/dashboard');
  assert.equal(data.compare_date, lastWeek);
  const card = data.locations.find((l) => l.id === site);
  assert.deepEqual([card.gross_today, card.sales_today], [600, 500]);
  const hour = Math.floor(nowMinutes() / 60);
  if (hour > 0 && hour < 23) {
    assert.equal(card.last_week.net, 100, 'only last week’s sales up to this time');
    assert.equal(card.last_week.gross, 120, 'gross scaled like net');
  }
  assert.equal(card.labour_basis, 'clocked');
  const mine = card.clock_ins.find((c) => c.name === person.name && c.start === '00:00');
  assert.ok(mine, 'the clock-in is listed');
  assert.equal(mine.hours, 0.5);
  assert.ok(card.labour_cost_today >= 6);

  const staff = await login('staff1@cafe.local');
  // Staff can only see the dashboard once it's ticked for them, and even then not sales or clock-ins.
  const set = db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in = 'staff'`).get();
  assert.ok(!JSON.parse(set.permissions).includes('dashboard.view'), 'off for staff by default');
  db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(set.permissions), 'dashboard.view']), set.id);
  const staffCard = (await staff('/dashboard')).locations[0];
  assert.equal(staffCard.gross_today, undefined, 'staff don’t see sales');
  assert.equal(staffCard.clock_ins, undefined, 'or clock-ins');
});
