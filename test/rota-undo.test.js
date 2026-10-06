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
const user = (email) => db.prepare('SELECT id, location_id FROM users WHERE email = ?').get(email);
const row = (id) => db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
const snapshot = (id) => { const r = row(id); return r ? { ...r } : null; };

test('the last unpublished rota change can be undone, until the next change or a publish', async () => {
  const manager = await login('manager1@cafe.local');
  const a = user('staff1@cafe.local');
  const b = user('staff1-3@cafe.local');
  const week = weekStart(addDays(today(), 21));
  const day = addDays(week, 2);
  db.prepare('DELETE FROM shifts WHERE date BETWEEN ? AND ?').run(week, addDays(week, 6));
  const undo = () => manager('/rota/undo', { method: 'POST' });
  const pending = async () => (await manager(`/rota?location_id=${a.location_id}&week=${week}`)).data.undo;

  // Adding a shift: undo removes it.
  const added = (await manager('/shifts', { method: 'POST', body: { location_id: a.location_id, user_id: a.id, date: day, start_time: '09:00', end_time: '17:00', break_minutes: 30 } })).data;
  assert.match((await pending()).label, /^Added .+’s shift/);
  assert.equal((await undo()).status, 200);
  assert.equal(row(added.id), undefined);
  assert.equal(await pending(), null, 'nothing left to undo');
  assert.equal((await undo()).status, 400);

  // Changing a published shift (giving it to someone else): undo puts it back exactly.
  const id = Number(db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes,
    pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes) VALUES (?, ?, ?, '07:00', '15:00', 30, ?, ?, ?, '07:00', '15:00', 30)`)
    .run(a.location_id, a.id, day, a.location_id, a.id, day).lastInsertRowid);
  const original = snapshot(id);
  await manager(`/shifts/${id}`, { method: 'PUT', body: { location_id: a.location_id, user_id: b.id, date: day, start_time: '08:00', end_time: '16:00', break_minutes: 30 } });
  assert.equal(row(id).user_id, b.id);
  await undo();
  assert.deepEqual(snapshot(id), original);

  // Removing a published shift (marked removed): undo brings it back.
  await manager(`/shifts/${id}`, { method: 'DELETE' });
  assert.equal(row(id).removed, 1);
  await undo();
  assert.deepEqual(snapshot(id), original);

  // Copying a week over this one, replacing it: undo restores the week as it was.
  const lastWeek = addDays(week, -7);
  db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (?, ?, ?, '10:00', '14:00', 0)`).run(a.location_id, b.id, addDays(lastWeek, 1));
  const weekBefore = db.prepare('SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY id').all(week, addDays(week, 6)).map((r) => ({ ...r }));
  const copied = await manager('/rota/copy-week', { method: 'POST', body: { location_id: a.location_id, from_week: lastWeek, to_week: week, replace: true } });
  assert.ok(copied.data.copied >= 1);
  await undo();
  assert.deepEqual(db.prepare('SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY id').all(week, addDays(week, 6)).map((r) => ({ ...r })), weekBefore);

  // Publishing ends the chance to undo; so does someone else changing the same shift.
  await manager(`/shifts/${id}`, { method: 'PUT', body: { location_id: a.location_id, user_id: a.id, date: day, start_time: '07:30', end_time: '15:00', break_minutes: 30 } });
  await manager('/rota/publish', { method: 'POST', body: { location_id: a.location_id, week } });
  assert.equal(await pending(), null);
  await manager(`/shifts/${id}`, { method: 'PUT', body: { location_id: a.location_id, user_id: a.id, date: day, start_time: '07:45', end_time: '15:00', break_minutes: 30 } });
  const admin = await login('admin@cafe.local');
  await admin(`/shifts/${id}`, { method: 'PUT', body: { location_id: a.location_id, user_id: a.id, date: day, start_time: '06:00', end_time: '15:00', break_minutes: 30 } });
  const refused = await undo();
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /changed since/);
  assert.equal(row(id).start_time, '06:00', 'the other person’s change is kept');
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE action = 'undo'`).get(), 'undos are recorded');
});
