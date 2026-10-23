import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
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
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

test('staff request holiday, a manager approves it, and they can’t be put on the rota then', async () => {
  const staff = await login('staff1@cafe.local');
  const manager = await login('manager1@cafe.local'); // same site as staff1
  const other = await login('manager2@cafe.local'); // a different site
  const start = addDays(weekStart(today()), 14);
  const end = addDays(start, 2);

  assert.equal((await staff('/leave', { method: 'POST', body: { start_date: addDays(today(), -1) } })).status, 400, 'not in the past');
  assert.equal((await staff('/leave', { method: 'POST', body: { start_date: end, end_date: start } })).status, 400);
  const req = await staff('/leave', { method: 'POST', body: { start_date: start, end_date: end, note: 'Family wedding' } });
  assert.equal(req.status, 201);
  assert.deepEqual([req.data.status, req.data.days], ['pending', 3]);
  assert.equal((await staff('/leave', { method: 'POST', body: { start_date: end } })).status, 400, 'overlaps');
  assert.equal((await staff('/leave?status=pending')).status, 403, 'staff can’t see everyone’s requests');

  assert.equal((await manager('/leave/pending-count')).data.count, 1);
  assert.equal((await other('/leave/pending-count')).data.count, 0, 'only their own site’s staff');
  const pending = (await manager('/leave')).data;
  assert.deepEqual(pending.map((r) => [r.user_name, r.note]), [[staff.me.name, 'Family wedding']]);
  assert.equal((await other(`/leave/${req.data.id}/decide`, { method: 'POST', body: { status: 'approved' } })).status, 404);

  // A shift already on the rota then is pointed out.
  const admin = await login('admin@cafe.local');
  await admin('/shifts', { method: 'POST', body: { location_id: staff.me.location_id, user_id: staff.me.id, date: start, start_time: '09:00', end_time: '12:00' } });
  assert.equal((await manager('/leave')).data[0].shifts.length, 1);

  const ok = await manager(`/leave/${req.data.id}/decide`, { method: 'POST', body: { status: 'approved', note: 'Enjoy!' } });
  assert.deepEqual([ok.data.status, ok.data.decision_note, ok.data.decided_by_name], ['approved', 'Enjoy!', manager.me.name]);
  const mine = (await staff('/leave/mine')).data;
  assert.equal(mine.requests[0].status, 'approved');
  assert.ok(mine.booked_this_year >= 0);

  const blocked = await admin('/shifts', { method: 'POST', body: { location_id: staff.me.location_id, user_id: staff.me.id, date: addDays(start, 1), start_time: '09:00', end_time: '12:00' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /on holiday/);
  const rota = (await manager(`/rota?week=${weekStart(start)}`)).data;
  assert.ok(rota.leave.some((l) => l.user_id === staff.me.id && l.status === 'approved'));
  assert.equal((await staff(`/rota?week=${weekStart(start)}`)).data.leave, undefined, 'staff don’t see others’ holiday');

  // Cancelling before it starts.
  assert.equal((await staff(`/leave/${req.data.id}/cancel`, { method: 'POST' })).data.status, 'cancelled');
  assert.equal((await admin('/shifts', { method: 'POST', body: { location_id: staff.me.location_id, user_id: staff.me.id, date: addDays(start, 1), start_time: '09:00', end_time: '12:00' } })).status, 201);
});

test('managers can’t approve their own holiday', async () => {
  const manager = await login('manager3@cafe.local');
  const r = await manager('/leave', { method: 'POST', body: { start_date: addDays(today(), 30) } });
  assert.equal((await manager(`/leave/${r.data.id}/decide`, { method: 'POST', body: { status: 'approved' } })).status, 403);
  const admin = await login('admin@cafe.local');
  assert.equal((await admin(`/leave/${r.data.id}/decide`, { method: 'POST', body: { status: 'approved' } })).status, 200);
});

test('staff set availability for days and repeating patterns; managers and the rota see it', async () => {
  const staff = await login('staff2@cafe.local');
  const manager = await login('manager2@cafe.local');
  const other = await login('staff1@cafe.local');
  const monday = weekStart(addDays(today(), 7));
  const tuesday = addDays(monday, 1);
  const cal = (q = '') => staff(`/availability/calendar?from=${monday}&to=${addDays(monday, 20)}${q}`);
  assert.deepEqual((await cal()).data.days, {}, 'available any time until they say otherwise');

  // A day: unavailable 09:00–12:00 and 14:00–16:00.
  const bad = await staff('/availability/days', { method: 'POST', body: { date: monday, kind: 'unavailable', ranges: [{ from_time: '17:00', to_time: '09:00' }] } });
  assert.equal(bad.status, 400);
  const day = await staff('/availability/days', { method: 'POST', body: { date: monday, kind: 'unavailable', ranges: [{ from_time: '09:00', to_time: '12:00' }, { from_time: '14:00', to_time: '16:00' }] } });
  assert.equal(day.status, 201);
  assert.equal(day.data.length, 2);

  // A pattern every 2 weeks: week 1 Tuesdays unavailable all day; week 2 Tuesdays available 10–15.
  const pat = await staff('/availability/patterns', { method: 'POST', body: { start_date: monday, weeks: 2, slots: [
    { week: 0, weekday: 1, kind: 'unavailable', all_day: true },
    { week: 1, weekday: 1, kind: 'available', from_time: '10:00', to_time: '15:00' },
    { week: 0, weekday: 0, kind: 'unavailable', all_day: true },
  ] } });
  assert.equal(pat.status, 201);
  let days = (await cal()).data.days;
  assert.deepEqual(days[tuesday].map((x) => [x.kind, x.all_day, x.source]), [['unavailable', true, 'pattern']]);
  assert.deepEqual(days[addDays(tuesday, 7)].map((x) => [x.kind, x.from_time, x.to_time]), [['available', '10:00', '15:00']]);
  assert.deepEqual(days[addDays(tuesday, 14)].map((x) => x.kind), ['unavailable'], 'repeats every two weeks');
  assert.equal(days[monday].length, 2, 'what was set for the day replaces the pattern that day');
  assert.ok(days[monday].every((x) => x.source === 'day'));
  // Clearing the day brings the pattern back.
  await staff('/availability/days/clear', { method: 'POST', body: { date: monday } });
  assert.deepEqual((await cal()).data.days[monday].map((x) => [x.all_day, x.source]), [[true, 'pattern']]);
  await staff('/availability/note', { method: 'PUT', body: { note: 'School run' } });

  // Someone else can't change it; their manager can, and sees it.
  assert.equal((await other('/availability/days', { method: 'POST', body: { user_id: staff.me.id, date: monday, kind: 'available', all_day: true } })).status, 403);
  assert.equal((await staff('/availability')).status, 403);
  const managed = await manager(`/availability/calendar?user_id=${staff.me.id}&from=${monday}&to=${addDays(monday, 6)}`);
  assert.equal(managed.status, 200);
  assert.ok(managed.data.people.some((p) => p.id === staff.me.id));
  assert.equal((await manager('/availability/days', { method: 'POST', body: { user_id: staff.me.id, date: addDays(monday, 2), kind: 'available', all_day: true } })).status, 201);
  const team = (await manager('/availability')).data;
  assert.equal(team.people.find((p) => p.id === staff.me.id).note, 'School run');
  assert.ok(team.people.every((p) => p.location_id === manager.me.location_id));

  // The rota for that week has it by date.
  const rota = (await manager(`/rota?week=${monday}`)).data;
  assert.deepEqual(rota.availability[staff.me.id].days[tuesday].map((x) => x.kind), ['unavailable']);
  assert.deepEqual(rota.availability[staff.me.id].days[addDays(monday, 2)].map((x) => [x.kind, x.all_day]), [['available', true]]);

  // Deleting the pattern removes it from every week.
  await staff(`/availability/patterns/${pat.data.id}`, { method: 'DELETE' });
  assert.equal((await cal()).data.days[tuesday], undefined);
});
