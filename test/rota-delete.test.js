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
    return { status: r.status, data: await r.json() };
  };
}

test('deleting a published (or changed) shift takes it off staff’s rota straight away, and Undo brings it back', async () => {
  const m = await login('manager1@cafe.local');
  const staff = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  const week = weekStart(addDays(today(), 14));
  const day = addDays(week, 2);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(staff.id, day);
  const s = (await m('/shifts', { method: 'POST', body: { location_id: staff.location_id, user_id: staff.id, date: day, start_time: '09:00', end_time: '17:00' } })).data;
  await m('/rota/publish', { method: 'POST', body: { location_id: staff.location_id, week } });
  // Changed since publishing (so it shows as unpublished), then deleted.
  await m(`/shifts/${s.id}`, { method: 'PUT', body: { location_id: staff.location_id, user_id: staff.id, date: day, start_time: '10:00', end_time: '17:00' } });
  const del = await m(`/shifts/${s.id}`, { method: 'DELETE' });
  assert.equal(del.data.removed_now, true);
  assert.ok(!db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(s.id), 'gone, not waiting to be published');
  assert.equal((await m(`/rota?week=${week}&location_id=${staff.location_id}`)).data.unpublished, 0, 'nothing left to publish');
  const st = await login('staff1@cafe.local');
  assert.ok(!(await st('/my-shifts')).data.some((x) => x.date === day), 'off their rota');
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Shift removed'`).get(staff.id));
  // Undo puts back exactly what staff saw.
  assert.equal((await m('/rota/undo', { method: 'POST' })).status, 200);
  const mine = (await st('/my-shifts')).data.find((x) => x.date === day);
  assert.equal(mine.start_time, '09:00', 'the published version is back');
});

test('people who can edit but not publish still have deletions wait to be published', async () => {
  const a = await login('admin@cafe.local');
  const staff = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1-2@cafe.local'`).get();
  const week = weekStart(addDays(today(), 21));
  const s = (await a('/shifts', { method: 'POST', body: { location_id: staff.location_id, user_id: staff.id, date: week, start_time: '09:00', end_time: '17:00' } })).data;
  await a('/rota/publish', { method: 'POST', body: { location_id: staff.location_id, week } });
  const set = db.prepare(`INSERT INTO permission_sets (name, permissions) VALUES ('Rota editor', ?)`).run(JSON.stringify(['rota.view', 'rota.edit'])).lastInsertRowid;
  db.prepare(`UPDATE users SET permission_set_id = ? WHERE email = 'staff1-3@cafe.local'`).run(set);
  const editor = await login('staff1-3@cafe.local');
  const del = await editor(`/shifts/${s.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.data.removed_now, false);
  assert.equal(db.prepare('SELECT removed FROM shifts WHERE id = ?').get(s.id).removed, 1, 'waits for someone to publish');
});
