import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb, publishAllShifts } from '../src/db.js';
import { setPushSender } from '../src/push.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;
let db;
const pushed = [];
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  publishAllShifts(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  setPushSender(async (_sub, payload) => { pushed.push(JSON.parse(payload)); });
});
after(() => { setPushSender(null); server.close(); });

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

test('staff confirm their published shifts; a published change asks them to confirm again; managers see who hasn’t', async () => {
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local');
  const me = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  // A shift of theirs next week, published.
  const week = weekStart(addDays(today(), 7));
  const made = await manager('/shifts', { method: 'POST', body: { location_id: me.location_id, user_id: me.id, date: addDays(week, 2), start_time: '09:00', end_time: '13:00' } });
  assert.equal(made.status, 201);
  await manager('/rota/publish', { method: 'POST', body: { location_id: me.location_id, week } });

  const waiting = (await staff('/my-shifts/unconfirmed')).data;
  assert.ok(waiting.count >= 1 && waiting.weeks.includes(week));
  const mine = (await staff(`/my-shifts?week=${week}`)).data;
  assert.equal(mine.find((s) => s.id === made.data.id).ack_at, null);

  // The manager sees them waiting on the rota.
  let rota = (await manager(`/rota?location_id=${me.location_id}&week=${week}`)).data;
  assert.ok(rota.confirmations.waiting.some((w) => w.user_id === me.id));
  // …and can remind them.
  db.prepare(`INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/c1', 'k', 'a')`).run(me.id);
  pushed.length = 0;
  const reminded = await manager('/rota/confirm-reminder', { method: 'POST', body: { location_id: me.location_id, week } });
  assert.ok(reminded.data.reminded >= 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(pushed.some((p) => p.title === 'Please confirm your shifts'));

  // They confirm; it's recorded and the manager sees it.
  const confirmed = await staff('/my-shifts/confirm', { method: 'POST', body: { ids: [made.data.id] } });
  assert.equal(confirmed.data.confirmed, 1);
  assert.ok((await staff(`/my-shifts?week=${week}`)).data.find((s) => s.id === made.data.id).ack_at);
  rota = (await manager(`/rota?location_id=${me.location_id}&week=${week}`)).data;
  assert.ok(rota.shifts.find((s) => s.id === made.data.id).ack_at);
  // Someone can't confirm another person's shift.
  const other = await login('staff1-2@cafe.local');
  assert.equal((await other('/my-shifts/confirm', { method: 'POST', body: { ids: [made.data.id] } })).data.confirmed, 0);

  // Changing it and publishing again asks them to confirm again; an unpublished change doesn't.
  await manager(`/shifts/${made.data.id}`, { method: 'PUT', body: { location_id: me.location_id, user_id: me.id, date: addDays(week, 2), start_time: '10:00', end_time: '14:00' } });
  assert.ok((await staff(`/my-shifts?week=${week}`)).data.find((s) => s.id === made.data.id).ack_at, 'still confirmed until the change is published');
  await manager('/rota/publish', { method: 'POST', body: { location_id: me.location_id, week } });
  assert.equal((await staff(`/my-shifts?week=${week}`)).data.find((s) => s.id === made.data.id).ack_at, null);

  // Confirming everything at once.
  await staff('/my-shifts/confirm', { method: 'POST', body: {} });
  assert.equal((await staff('/my-shifts/unconfirmed')).data.count, 0);
});
