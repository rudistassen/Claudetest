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
const user = (email) => db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);

test('a manager adds holiday for someone, changes the dates and takes it off', async () => {
  const m = await login('manager1@cafe.local');
  const staff = user('staff1@cafe.local');
  const from = addDays(today(), 20);
  assert.ok((await m('/leave/people')).data.some((p) => p.id === staff.id));

  const added = await m('/leave/add', { method: 'POST', body: { user_id: staff.id, start_date: from, end_date: addDays(from, 2), note: 'Booked by phone' } });
  assert.equal(added.status, 201);
  assert.equal(added.data.status, 'approved');
  assert.equal(added.data.days, 3);
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Holiday added ✓'`).get(staff.id));
  // Can't be added twice over the same days.
  assert.equal((await m('/leave/add', { method: 'POST', body: { user_id: staff.id, start_date: addDays(from, 1) } })).status, 400);

  // Add a day on the end.
  const changed = await m(`/leave/${added.data.id}`, { method: 'PUT', body: { start_date: from, end_date: addDays(from, 3) } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.days, 4);
  // Shifts can't go on the rota while they're on holiday...
  const site = db.prepare('SELECT location_id FROM users WHERE id = ?').get(staff.id).location_id;
  const shift = { location_id: site, user_id: staff.id, date: addDays(from, 3), start_time: '09:00', end_time: '17:00' };
  assert.equal((await m('/shifts', { method: 'POST', body: shift })).status, 400);
  // ...until it's taken off.
  assert.equal((await m(`/leave/${added.data.id}/remove`, { method: 'POST', body: { note: 'Not going now' } })).status, 200);
  assert.equal(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(added.data.id).status, 'cancelled');
  assert.equal((await m('/shifts', { method: 'POST', body: shift })).status, 201);
  assert.equal((await m(`/leave/${added.data.id}/remove`, { method: 'POST' })).status, 400, 'already off');
  const log = db.prepare(`SELECT details FROM rota_log WHERE action = 'holiday' ORDER BY id`).all().map((r) => r.details).join('\n');
  assert.match(log, /added for/);
  assert.match(log, /changed from/);
  assert.match(log, /taken off/);
});

test('past holiday can be recorded; staff can’t change anyone else’s; managers can’t change their own', async () => {
  const m = await login('manager1@cafe.local');
  const staff = user('staff1-2@cafe.local');
  const past = await m('/leave/add', { method: 'POST', body: { user_id: staff.id, start_date: addDays(today(), -10), end_date: addDays(today(), -8) } });
  assert.equal(past.status, 201);
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/leave/add', { method: 'POST', body: { user_id: staff.id, start_date: today() } })).status, 403);
  assert.equal((await s(`/leave/${past.data.id}/remove`, { method: 'POST' })).status, 403);
  assert.equal((await m('/leave/add', { method: 'POST', body: { user_id: user('manager1@cafe.local').id, start_date: addDays(today(), 40) } })).status, 403);
  // A manager at another site can't touch it.
  const other = await login('manager2@cafe.local');
  assert.equal((await other(`/leave/${past.data.id}`, { method: 'PUT', body: { start_date: addDays(today(), -10) } })).status, 404);
});
