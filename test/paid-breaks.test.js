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

test('staff on paid breaks aren’t flagged for missed breaks, and the setting is kept on their staff details', async () => {
  const a = await login('admin@cafe.local');
  const person = db.prepare(`SELECT * FROM users WHERE email = 'staff1@cafe.local'`).get();
  const day = addDays(today(), -1);
  // Nine hours clocked with no break (break details synced).
  db.prepare(`INSERT INTO timecards (id, location_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status, breaks_synced)
    VALUES ('TC-PB', ?, ?, ?, ?, ?, 0, 12, 'CLOSED', 1)`).run(person.location_id, person.id, day, `${day}T07:00:00Z`, `${day}T16:00:00Z`);
  const report = async () => (await a(`/breaks?from=${day}&to=${day}&location_id=${person.location_id}`)).data.rows.find((r) => r.id === 'TC-PB');
  assert.equal((await report()).break_flag, 'none');

  const before = (await a('/users')).data.find((u) => u.id === person.id);
  assert.equal(before.paid_breaks, 0);
  const saved = await a(`/users/${person.id}`, { method: 'PUT', body: {
    name: before.name, email: before.email, location_id: before.location_id, hourly_rate: before.hourly_rate, rota_group: before.rota_group,
    permission_set_id: before.permission_set_id, active: true, paid_breaks: true,
  } });
  assert.equal(saved.status, 200);
  assert.equal((await a('/users')).data.find((u) => u.id === person.id).paid_breaks, 1);
  assert.equal((await report()).break_flag, null, 'no warning on the Breaks report');

  // Saving their details from somewhere that doesn't send the tick leaves it as it is.
  await a(`/users/${person.id}`, { method: 'PUT', body: { name: before.name, email: before.email, location_id: before.location_id, hourly_rate: before.hourly_rate, permission_set_id: before.permission_set_id } });
  assert.equal(db.prepare('SELECT paid_breaks FROM users WHERE id = ?').get(person.id).paid_breaks, 1);
});
