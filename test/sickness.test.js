import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { attendance } from '../src/attendance.js';
import { openDb } from '../src/db.js';
import { rotaByDay } from '../src/metrics.js';
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
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
}

test('a shift marked as sickness stays on the rota but isn’t labour, a missed clock-in, or hours; it’s in the report', async () => {
  const day = addDays(today(), -1);
  const u = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(u.id, day);
  const shiftId = Number(db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes,
    pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes) VALUES (?, ?, ?, '08:00', '15:00', 0, ?, ?, ?, '08:00', '15:00', 0)`)
    .run(u.location_id, u.id, day, u.location_id, u.id, day).lastInsertRowid);
  const cost = () => rotaByDay(db, [u.location_id], day, day).get(`${u.location_id}|${day}`)?.hours ?? 0;
  const missed = () => attendance(db, u.location_id, day, []).missing.some((m) => m.shift_id === shiftId);
  const before = cost();
  assert.ok(missed(), 'missed until marked sick');

  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/shifts/${shiftId}/sickness`, { method: 'POST', body: {} })).status, 403, 'staff can’t mark sickness');
  const manager = await login('manager1@cafe.local');
  const marked = await manager(`/shifts/${shiftId}/sickness`, { method: 'POST', body: { note: 'Flu' } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.sick, 1);
  assert.equal(cost(), before - 7, 'the 7 hours no longer count');
  assert.ok(!missed(), 'not a missed clock-in');
  assert.deepEqual(attendance(db, u.location_id, day, []).sick.map((s) => [s.shift_id, s.note]), [[shiftId, 'Flu']]);

  const report = (await manager('/reports/sickness')).data;
  assert.deepEqual(report.shifts.map((s) => [s.id, s.sick_note, s.hours]), [[shiftId, 'Flu', 7]]);
  assert.equal(report.people[0].days, 1);
  assert.equal((await staff('/reports/sickness')).status, 403);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM rota_log WHERE action = 'sick'`).get().n, 1);

  await manager(`/shifts/${shiftId}/sickness`, { method: 'POST', body: { sick: false } });
  assert.equal(cost(), before, 'back to counting');
  assert.deepEqual((await manager('/reports/sickness')).data.shifts, []);
});
