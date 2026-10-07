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
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

test('a person can have more than one shift in a day, as long as they don’t overlap', async () => {
  const admin = await login('admin@cafe.local');
  const s = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  const day = addDays(today(), 40);
  const shift = (start_time, end_time) => admin('/shifts', { method: 'POST', body: { location_id: s.location_id, user_id: s.id, date: day, start_time, end_time } });
  assert.equal((await shift('07:00', '11:00')).status, 201);
  assert.equal((await shift('16:00', '20:00')).status, 201, 'a split shift later the same day');
  assert.equal((await shift('11:00', '16:00')).status, 201, 'one starting as another ends');
  const overlap = await shift('10:00', '12:00');
  assert.equal(overlap.status, 400);
  assert.match(overlap.data.error, /already has a shift 07:00–11:00/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE user_id = ? AND date = ? AND removed = 0').get(s.id, day).n, 3);
});

test('quick shift times look ahead and fill up to five', async () => {
  const admin = await login('admin@cafe.local');
  // A new site with one shift time used so far, and another planned next week.
  const site = Number(db.prepare(`INSERT INTO locations (name, active) VALUES ('Quick times test', 1)`).run().lastInsertRowid);
  const s = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get();
  const add = (date, start_time, end_time) => admin('/shifts', { method: 'POST', body: { location_id: site, user_id: s.id, date, start_time, end_time } });
  assert.equal((await add(addDays(today(), -3), '05:00', '06:00')).status, 201);
  assert.equal((await add(addDays(today(), 10), '05:30', '06:30')).status, 201);
  const times = (await admin(`/rota/common-times?location_id=${site}`)).data;
  assert.deepEqual(times.slice(0, 2).map((t) => `${t.start_time}–${t.end_time}`).sort(), ['05:00–06:00', '05:30–06:30']);
  assert.equal(times.length, 5, 'filled up with times used at the other sites');
});
