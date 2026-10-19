import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb, publishAllShifts } from '../src/db.js';
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
  publishAllShifts(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
const user = (email) => db.prepare('SELECT id, location_id, name FROM users WHERE email = ?').get(email);
// A published shift for someone a few days ahead (added fresh so the test doesn't depend on the demo rota).
function shiftFor(u, daysAhead, start, end) {
  const d = addDays(today(), daysAhead);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(u.id, d);
  return Number(db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0)`).run(u.location_id, u.id, d, start, end, u.location_id, u.id, d, start, end).lastInsertRowid);
}

test('shift swap: asked, agreed by the colleague, approved by a manager – then the shifts change hands', async () => {
  const a = user('staff1@cafe.local');
  const b = user('staff1-2@cafe.local');
  const mine = shiftFor(a, 3, '09:00', '13:00');
  const theirs = shiftFor(b, 4, '12:00', '17:00');
  // Make sure neither is working the other's day.
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ? AND id != ?').run(b.id, addDays(today(), 3), theirs);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ? AND id != ?').run(a.id, addDays(today(), 4), mine);
  const asA = await login('staff1@cafe.local');
  const asB = await login('staff1-2@cafe.local');
  const manager = await login('manager1@cafe.local');

  const opts = (await asA(`/swaps/options?shift_id=${mine}`)).data;
  const them = opts.people.find((p) => p.id === b.id);
  assert.ok(them && them.shifts.some((x) => x.id === theirs));
  assert.equal((await asB(`/swaps/options?shift_id=${mine}`)).status, 404, 'only your own shifts');

  const asked = await asA('/swaps', { method: 'POST', body: { shift_id: mine, to_user_id: b.id, to_shift_id: theirs, note: 'Dentist' } });
  assert.equal(asked.status, 201);
  assert.equal(asked.data.status, 'asked');
  // Not twice, and a manager can't approve before the colleague agrees.
  assert.equal((await asA('/swaps', { method: 'POST', body: { shift_id: mine, to_user_id: b.id } })).status, 400);
  assert.equal((await manager(`/swaps/${asked.data.id}/approve`, { method: 'POST' })).status, 400);
  assert.equal((await asA(`/swaps/${asked.data.id}/accept`, { method: 'POST' })).status, 404, 'only the colleague agrees');

  assert.ok((await asB('/swaps')).data.for_me.some((w) => w.id === asked.data.id));
  assert.equal((await asB(`/swaps/${asked.data.id}/accept`, { method: 'POST' })).data.status, 'pending');
  const queue = (await manager('/swaps')).data.to_approve;
  assert.ok(queue.some((w) => w.id === asked.data.id && !w.problem));
  // Staff can't approve.
  assert.equal((await asA(`/swaps/${asked.data.id}/approve`, { method: 'POST' })).status, 403);

  const done = await manager(`/swaps/${asked.data.id}/approve`, { method: 'POST' });
  assert.equal(done.data.status, 'approved');
  const pubA = db.prepare('SELECT pub_user_id, user_id, ack_at FROM shifts WHERE id = ?').get(mine);
  const pubB = db.prepare('SELECT pub_user_id, user_id FROM shifts WHERE id = ?').get(theirs);
  assert.deepEqual([pubA.pub_user_id, pubA.user_id, pubB.pub_user_id, pubB.user_id], [b.id, b.id, a.id, a.id], 'swapped, and published straight away');
  assert.ok(pubA.ack_at, 'counts as confirmed');
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE action = 'swap'`).get(), 'in Rota changes');
});

test('shift swap: a cover (nothing back), said no to, called off, declined, and stopped if the shift changes', async () => {
  const a = user('staff1@cafe.local');
  const b = user('staff1-3@cafe.local');
  const asA = await login('staff1@cafe.local');
  const asB = await login('staff1-3@cafe.local');
  const manager = await login('manager1@cafe.local');
  const s1 = shiftFor(a, 8, '07:00', '11:00');
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(b.id, addDays(today(), 8));

  const no = (await asA('/swaps', { method: 'POST', body: { shift_id: s1, to_user_id: b.id } })).data;
  assert.equal(no.take, null);
  assert.equal((await asB(`/swaps/${no.id}/refuse`, { method: 'POST' })).data.status, 'refused');

  const off = (await asA('/swaps', { method: 'POST', body: { shift_id: s1, to_user_id: b.id } })).data;
  assert.equal((await asA(`/swaps/${off.id}/cancel`, { method: 'POST' })).status, 200);

  const dec = (await asA('/swaps', { method: 'POST', body: { shift_id: s1, to_user_id: b.id } })).data;
  await asB(`/swaps/${dec.id}/accept`, { method: 'POST' });
  assert.equal((await manager(`/swaps/${dec.id}/decline`, { method: 'POST', body: { note: 'Need you both' } })).data.status, 'declined');
  assert.equal(db.prepare('SELECT pub_user_id FROM shifts WHERE id = ?').get(s1).pub_user_id, a.id, 'still theirs');

  // The shift changes (and is published) after the colleague agrees: it can't be approved.
  const changed = (await asA('/swaps', { method: 'POST', body: { shift_id: s1, to_user_id: b.id } })).data;
  await asB(`/swaps/${changed.id}/accept`, { method: 'POST' });
  db.prepare(`UPDATE shifts SET start_time = '08:00', pub_start_time = '08:00' WHERE id = ?`).run(s1);
  const r = await manager(`/swaps/${changed.id}/approve`, { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /changed/);
});

test('shift swap: a manager can’t approve a swap they’re part of', async () => {
  const a = user('staff1@cafe.local');
  const m = user('manager1@cafe.local');
  const asA = await login('staff1@cafe.local');
  const asM = await login('manager1@cafe.local');
  const s1 = shiftFor(a, 10, '07:00', '11:00');
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ?').run(m.id, addDays(today(), 10));
  const w = (await asA('/swaps', { method: 'POST', body: { shift_id: s1, to_user_id: m.id } })).data;
  await asM(`/swaps/${w.id}/accept`, { method: 'POST' });
  assert.ok(!(await asM('/swaps')).data.to_approve.some((x) => x.id === w.id));
  assert.equal((await asM(`/swaps/${w.id}/approve`, { method: 'POST' })).status, 403);
  const admin = await login('admin@cafe.local');
  assert.equal((await admin(`/swaps/${w.id}/approve`, { method: 'POST' })).data.status, 'approved');
});

test('managers can swap two shifts directly on the rota (a draft change, with undo)', async () => {
  const a = user('staff1@cafe.local');
  const b = user('staff1-2@cafe.local');
  const s1 = shiftFor(a, 12, '07:00', '11:00');
  const s2 = shiftFor(b, 13, '12:00', '16:00');
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ? AND id != ?').run(b.id, addDays(today(), 12), s2);
  db.prepare('DELETE FROM shifts WHERE user_id = ? AND date = ? AND id != ?').run(a.id, addDays(today(), 13), s1);
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/shifts/${s1}/swap`, { method: 'POST', body: { with_shift_id: s2 } })).status, 403);
  const r = await manager(`/shifts/${s1}/swap`, { method: 'POST', body: { with_shift_id: s2 } });
  assert.equal(r.status, 200);
  const row = (id) => db.prepare('SELECT user_id, pub_user_id FROM shifts WHERE id = ?').get(id);
  // Swapped in the draft; staff still see the old rota until it's published.
  assert.deepEqual([row(s1).user_id, row(s2).user_id], [b.id, a.id]);
  assert.deepEqual([row(s1).pub_user_id, row(s2).pub_user_id], [a.id, b.id]);
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE action = 'swap' AND details LIKE '%swapped from%'`).get());
  // Undo puts it back.
  assert.equal((await manager('/rota/undo', { method: 'POST' })).status, 200);
  assert.deepEqual([row(s1).user_id, row(s2).user_id], [a.id, b.id]);
  // Not with yourself, and not if it would double-book someone.
  assert.equal((await manager(`/shifts/${s1}/swap`, { method: 'POST', body: { with_shift_id: s1 } })).status, 400);
  const clash = shiftFor(b, 12, '08:00', '10:00');
  assert.equal((await manager(`/shifts/${s1}/swap`, { method: 'POST', body: { with_shift_id: s2 } })).status, 400);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(clash);
});

test('admins can delete the week’s unpublished shifts – published ones stay – and undo it', async () => {
  const u = user('staff1@cafe.local');
  const week = addDays(today(), 70);
  const ws = week; // any day in the week will do
  const published = shiftFor(u, 70, '09:00', '13:00');
  const fresh = Number(db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (?, ?, ?, '14:00', '18:00', 0)`)
    .run(u.location_id, u.id, week).lastInsertRowid);
  const m = await login('manager1@cafe.local');
  assert.equal((await m('/rota/delete-unpublished', { method: 'POST', body: { location_id: u.location_id, week: ws } })).status, 403, 'admins only');
  const a = await login('admin@cafe.local');
  const r = await a('/rota/delete-unpublished', { method: 'POST', body: { location_id: u.location_id, week: ws } });
  assert.ok(r.data.deleted >= 1);
  assert.ok(!db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(fresh), 'the unpublished shift is gone');
  assert.ok(db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(published), 'the published one stays');
  assert.equal((await a('/rota/undo', { method: 'POST' })).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(fresh), 'undo puts it back');
});
