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

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); return { status: r.status, data: await r.json() }; };
}

test('the shift window offers a site’s five most used shift times from the last 4 weeks, with their usual break', async () => {
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const person = db.prepare('SELECT id FROM users WHERE location_id = ? LIMIT 1').get(site).id;
  db.prepare('DELETE FROM shifts WHERE location_id = ?').run(site);
  const add = (daysAgo, start, end, brk) => db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(site, person, addDays(today(), -daysAgo), start, end, brk);
  for (let i = 0; i < 4; i++) add(i, '07:00', '15:00', 30);
  add(5, '07:00', '15:00', 20);
  for (let i = 0; i < 3; i++) add(i, '10:00', '17:00', 30);
  for (const [s, e] of [['06:00', '12:00'], ['12:00', '18:00'], ['08:00', '16:00'], ['09:00', '13:00']]) add(2, s, e, 0);
  for (let i = 0; i < 9; i++) add(40, '05:00', '11:00', 0); // too long ago
  add(-3, '11:00', '19:00', 0); // in the future

  const admin = await login('admin@cafe.local');
  const r = await admin(`/rota/common-times?location_id=${site}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 5);
  assert.deepEqual(r.data.slice(0, 2), [
    { start_time: '07:00', end_time: '15:00', count: 5, break_minutes: 30 },
    { start_time: '10:00', end_time: '17:00', count: 3, break_minutes: 30 },
  ]);
  assert.ok(!r.data.some((t) => t.start_time === '05:00' || t.start_time === '11:00'));
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/rota/common-times?location_id=${site}`)).status, 403);
});
