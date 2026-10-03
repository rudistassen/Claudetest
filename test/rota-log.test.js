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
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

test('every rota change is logged with who did it, when, and what changed', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const person = db.prepare(`SELECT id, name FROM users WHERE location_id = ? AND role = 'staff' AND active = 1 LIMIT 1`).get(site);
  const week = weekStart(addDays(today(), 21));
  const day = addDays(week, 2);
  const log = async (q = '') => (await manager(`/rota/log?location_id=${site}${q}`)).data.entries;
  const before = (await log()).length;

  const added = await manager('/shifts', { method: 'POST', body: { location_id: site, user_id: person.id, date: day, start_time: '09:00', end_time: '17:00', break_minutes: 30 } });
  assert.equal(added.status, 201);
  const id = added.data.id;
  let entries = await log();
  assert.equal(entries.length, before + 1);
  assert.equal(entries[0].action, 'add');
  assert.equal(entries[0].actor_name, manager.me.name);
  assert.equal(entries[0].staff_name, person.name);
  assert.equal(entries[0].shift_date, day);
  assert.match(entries[0].details, /09:00–17:00 \(30m break\)/);
  assert.match(entries[0].at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

  await manager(`/shifts/${id}`, { method: 'PUT', body: { location_id: site, user_id: person.id, date: day, start_time: '10:00', end_time: '17:00', break_minutes: 45 } });
  entries = await log();
  assert.equal(entries[0].action, 'change');
  assert.match(entries[0].details, /time 09:00–17:00 → 10:00–17:00; break 30m → 45m/);

  // Saving without changing anything isn't logged.
  await manager(`/shifts/${id}`, { method: 'PUT', body: { location_id: site, user_id: person.id, date: day, start_time: '10:00', end_time: '17:00', break_minutes: 45 } });
  assert.equal((await log()).length, before + 2);

  await manager('/rota/publish', { method: 'POST', body: { location_id: site, week } });
  entries = await log();
  assert.equal(entries[0].action, 'publish');
  assert.match(entries[0].details, /^Published 1 change for the week of /);

  await manager(`/shifts/${id}`, { method: 'DELETE' });
  assert.equal((await log())[0].action, 'remove');
  await manager(`/shifts/${id}/restore`, { method: 'POST' });
  assert.equal((await log())[0].action, 'restore');
  await manager(`/shifts/${id}`, { method: 'DELETE' });
  await manager(`/shifts/${id}/publish`, { method: 'POST' });
  entries = await log();
  assert.equal(entries[0].action, 'publish_shift');
  assert.match(entries[0].details, /^Published the removal of /);

  // One shift's own history, newest first (publishing a whole week is logged for the site, not each shift).
  const history = (await manager(`/rota/log?shift_id=${id}`)).data.entries.map((e) => e.action);
  assert.deepEqual(history, ['publish_shift', 'remove', 'restore', 'remove', 'change', 'add']);

  // Filters: by kind of change and by person.
  assert.ok((await log('&action=publish')).every((e) => e.action === 'publish' || e.action === 'publish_shift'));
  assert.ok((await log(`&staff_id=${person.id}`)).every((e) => e.staff_id === person.id));
});

test('copying and discarding a week are logged per site', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const thisWeek = weekStart(today());
  const target = addDays(thisWeek, 35);
  const copy = await manager('/rota/copy-week', { method: 'POST', body: { location_id: site, from_week: thisWeek, to_week: target } });
  assert.equal(copy.status, 200);
  let entries = (await manager(`/rota/log?location_id=${site}&action=copy`)).data.entries;
  assert.match(entries[0].details, new RegExp(`^Copied ${copy.data.copied} shift`));
  await manager('/rota/discard', { method: 'POST', body: { location_id: site, week: target } });
  entries = (await manager(`/rota/log?location_id=${site}&action=discard`)).data.entries;
  assert.match(entries[0].details, new RegExp(`^Discarded ${copy.data.copied} unpublished change`));
});

test('only people who edit the rota see the log, and only for their sites', async () => {
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/rota/log')).status, 403);
  const manager2 = await login('manager2@cafe.local');
  const theirs = (await manager2('/rota/log')).data.entries;
  assert.ok(theirs.every((e) => e.location_id === manager2.me.location_id), 'another site’s changes stay hidden');
  const manager1 = await login('manager1@cafe.local');
  assert.equal((await manager2(`/rota/log?location_id=${manager1.me.location_id}`)).status, 403);
  const admin = await login('admin@cafe.local');
  assert.ok((await admin('/rota/log')).data.entries.length >= 1, 'admins see every site');
});
