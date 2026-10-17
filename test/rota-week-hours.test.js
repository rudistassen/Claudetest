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
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

test('the rota shows each person’s hours at every site that week, not just the site shown', async () => {
  const admin = await login('admin@cafe.local');
  const person = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  const other = db.prepare('SELECT id FROM locations WHERE id != ? ORDER BY id LIMIT 1').get(person.location_id).id;
  const week = weekStart(addDays(today(), 14));
  // Two shifts at home (8h + 4h), one at another site (6h), and a sick shift elsewhere that doesn't count.
  const add = (location_id, date, start_time, end_time, break_minutes = 0) => admin('/shifts', { method: 'POST', body: { location_id, user_id: person.id, date, start_time, end_time, break_minutes } });
  for (const r of [
    await add(person.location_id, week, '08:00', '16:30', 30),
    await add(person.location_id, addDays(week, 1), '09:00', '13:00'),
    await add(other, addDays(week, 2), '10:00', '16:00'),
  ]) assert.equal(r.status, 201, JSON.stringify(r.data));
  const sick = await add(other, addDays(week, 3), '10:00', '14:00');
  db.prepare('UPDATE shifts SET sick = 1 WHERE id = ?').run(sick.data.id);

  const home = (await admin(`/rota?location_id=${person.location_id}&week=${week}`)).data;
  assert.equal(home.hours_by_user[person.id], 12, 'hours at this site');
  assert.deepEqual(home.week_hours_all_sites[person.id], { hours: 18, sites: 2 });

  const away = (await admin(`/rota?location_id=${other}&week=${week}`)).data;
  assert.equal(away.hours_by_user[person.id], 6);
  assert.deepEqual(away.week_hours_all_sites[person.id], { hours: 18, sites: 2 });
});
