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
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
}

// A published shift, as if the rota had been published.
function publishedShift(email, day, start = '09:00', end = '17:00') {
  const u = db.prepare('SELECT id, location_id FROM users WHERE email = ?').get(email);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(u.id, day);
  return Number(db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes,
    pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes) VALUES (?, ?, ?, ?, ?, 30, ?, ?, ?, ?, ?, 30)`)
    .run(u.location_id, u.id, day, start, end, u.location_id, u.id, day, start, end).lastInsertRowid);
}

test('a dropped shift is approved by a manager, becomes open at the site, and is picked up once', async () => {
  const day = addDays(today(), 3);
  const shiftId = publishedShift('staff1@cafe.local', day);
  const staff = await login('staff1@cafe.local');
  const colleague = await login('staff1-2@cafe.local');
  const manager = await login('manager1@cafe.local');

  assert.equal((await colleague(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).status, 404, 'only your own shift');
  const asked = await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: { reason: 'Exam' } });
  assert.equal(asked.status, 201);
  assert.equal((await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).status, 400, 'not twice');
  assert.equal((await staff('/my-shifts')).data.find((s) => s.id === shiftId).drop_requested, true);
  assert.deepEqual((await colleague('/shift-drops')).data.open, [], 'not open until approved');

  assert.equal((await colleague(`/shift-drops/${asked.data.id}/approve`, { method: 'POST' })).status, 403, 'staff can’t approve');
  const queue = (await manager('/shift-drops')).data.to_approve;
  assert.deepEqual(queue.map((d) => [d.id, d.reason, d.dropped_by_name]), [[asked.data.id, 'Exam', asked.data.dropped_by_name]]);
  assert.equal((await manager(`/shift-drops/${asked.data.id}/approve`, { method: 'POST' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE id = ?').get(shiftId).n, 0, 'off their rota');
  assert.ok(!(await staff('/my-shifts')).data.some((s) => s.date === day));

  // The colleague is already on that day, so can't pick it up until that's gone.
  const clashing = publishedShift('staff1-2@cafe.local', day, '12:00', '20:00');
  const seen = (await colleague('/shift-drops')).data.open.find((d) => d.id === asked.data.id);
  assert.equal(seen.can_claim, false);
  assert.match(seen.claim_problem, /already have a shift/);
  assert.equal((await colleague(`/shift-drops/${asked.data.id}/claim`, { method: 'POST' })).status, 400);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(clashing);

  const rota = (await manager(`/rota?week=${day}`)).data;
  assert.ok(rota.open_shifts.some((d) => d.id === asked.data.id), 'shown on the rota');

  const claimed = await colleague(`/shift-drops/${asked.data.id}/claim`, { method: 'POST' });
  assert.equal(claimed.status, 200);
  const mine = (await colleague('/my-shifts')).data.find((s) => s.date === day);
  assert.deepEqual([mine.start_time, mine.end_time, mine.break_minutes], ['09:00', '17:00', 30], 'straight onto their published rota');
  const again = await staff(`/shift-drops/${asked.data.id}/claim`, { method: 'POST' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already picked up/);
  const log = db.prepare(`SELECT action FROM rota_log WHERE action IN ('drop', 'claim') ORDER BY id`).all().map((r) => r.action);
  assert.deepEqual(log, ['drop', 'claim']);
});

test('a declined or cancelled drop leaves the shift where it was; managers can withdraw an open shift', async () => {
  const day = addDays(today(), 5);
  const shiftId = publishedShift('staff1@cafe.local', day);
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local');

  const first = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;
  assert.equal((await staff(`/shift-drops/${first.id}/cancel`, { method: 'POST' })).status, 200);
  const second = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;
  assert.equal((await manager(`/shift-drops/${second.id}/decline`, { method: 'POST', body: { note: 'Busy day' } })).status, 200);
  assert.ok((await staff('/my-shifts')).data.some((s) => s.id === shiftId), 'still theirs');
  assert.equal((await staff('/shift-drops')).data.mine.find((d) => d.id === second.id).status, 'declined');

  const third = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;
  await manager(`/shift-drops/${third.id}/approve`, { method: 'POST' });
  assert.equal((await manager(`/shift-drops/${third.id}/withdraw`, { method: 'POST' })).status, 200);
  assert.ok(!(await staff('/shift-drops')).data.open.some((d) => d.id === third.id));
});

test('a shift that has already started can’t be dropped', async () => {
  const shiftId = publishedShift('staff1@cafe.local', addDays(today(), -1));
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).status, 400);
});

test('a manager can drop someone’s shift straight to open; staff can’t', async () => {
  const day = addDays(today(), 6);
  const shiftId = publishedShift('staff1@cafe.local', day);
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local');
  const asked = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;

  assert.equal((await staff(`/shifts/${shiftId}/open`, { method: 'POST', body: {} })).status, 403);
  const opened = await manager(`/shifts/${shiftId}/open`, { method: 'POST', body: { reason: 'Moved to another site' } });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.status, 'open');
  assert.equal(opened.data.reason, 'Moved to another site');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE id = ?').get(shiftId).n, 0, 'off their rota');
  assert.equal(db.prepare('SELECT status FROM shift_drops WHERE id = ?').get(asked.id).status, 'cancelled', 'their own request is closed');
  assert.ok((await login('staff1-2@cafe.local').then((c) => c('/shift-drops'))).data.open.some((d) => d.id === opened.data.id), 'open to the site');
  assert.equal((await manager(`/shifts/${shiftId}/open`, { method: 'POST', body: {} })).status, 404, 'only once');
});

test('approving a drop can delete the shift instead of opening it up', async () => {
  const day = addDays(today(), 8);
  const shiftId = publishedShift('staff1@cafe.local', day);
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local');
  const asked = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;
  const done = await manager(`/shift-drops/${asked.id}/approve`, { method: 'POST', body: { delete: true } });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE id = ?').get(shiftId).n, 0, 'off their rota');
  assert.ok(!(await login('staff1-2@cafe.local').then((c) => c('/shift-drops'))).data.open.some((d) => d.id === asked.id), 'not offered to anyone');
  assert.match(db.prepare(`SELECT details FROM rota_log WHERE action = 'drop' ORDER BY id DESC LIMIT 1`).get().details, /shift deleted/);
});

test('holiday decisions and declined drop requests are recorded in Rota changes', async () => {
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local');
  const from = addDays(today(), 30);
  const asked = await staff('/leave', { method: 'POST', body: { start_date: from, end_date: addDays(from, 2), note: 'Wedding' } });
  assert.equal(asked.status, 201);
  assert.equal((await manager(`/leave/${asked.data.id}/decide`, { method: 'POST', body: { status: 'approved' } })).status, 200);
  const staffId = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get().id;
  const holiday = db.prepare(`SELECT * FROM rota_log WHERE action = 'holiday' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(holiday.staff_id, staffId);
  assert.equal(holiday.shift_date, from);
  assert.match(holiday.details, /\(3 days\) approved/);
  const listed = (await manager(`/rota/log?action=holiday`)).data.entries;
  assert.ok(listed.some((e) => e.id === holiday.id), 'shown in Rota changes');

  const shiftId = publishedShift('staff1@cafe.local', addDays(today(), 9));
  const drop = (await staff(`/shifts/${shiftId}/drop`, { method: 'POST', body: {} })).data;
  await manager(`/shift-drops/${drop.id}/decline`, { method: 'POST', body: { note: 'Short staffed' } });
  const declined = (await manager('/rota/log?action=drop')).data.entries.find((e) => e.action === 'drop_decline');
  assert.match(declined.details, /declined \(“Short staffed”\); it stays on their rota/);
});

test('a manager adds a new open shift, which anyone at the site can pick up', async () => {
  const day = addDays(today(), 4);
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = db.prepare('SELECT location_id FROM users WHERE email = ?').get('manager1@cafe.local').location_id;
  db.prepare('DELETE FROM shifts WHERE user_id = (SELECT id FROM users WHERE email = ?) AND date = ?').run('staff1@cafe.local', day);
  const body = { location_id: site, date: day, start_time: '10:00', end_time: '16:00', break_minutes: 30, notes: 'Busy lunch' };

  assert.equal((await staff('/shift-drops', { method: 'POST', body })).status, 403, 'staff can’t add open shifts');
  assert.equal((await manager('/shift-drops', { method: 'POST', body: { ...body, date: addDays(today(), -1) } })).status, 400, 'not in the past');
  const added = await manager('/shift-drops', { method: 'POST', body });
  assert.equal(added.status, 201);
  assert.equal(added.data.status, 'open');
  assert.equal(added.data.hours, 5.5);
  assert.ok(!(await manager('/shift-drops')).data.mine.some((d) => d.id === added.data.id), 'not shown as the manager’s own drop request');
  assert.ok((await manager(`/rota?week=${day}`)).data.open_shifts.some((d) => d.id === added.data.id), 'on the rota');
  assert.ok((await staff('/shift-drops')).data.open.find((d) => d.id === added.data.id).can_claim);
  assert.equal((await staff(`/shift-drops/${added.data.id}/claim`, { method: 'POST' })).status, 200);
  const mine = (await staff('/my-shifts')).data.find((s) => s.date === day);
  assert.deepEqual([mine.start_time, mine.end_time, mine.notes], ['10:00', '16:00', 'Busy lunch']);
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE action = 'open'`).get(), 'logged');
});
