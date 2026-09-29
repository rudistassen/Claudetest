import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

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


test('rota groups: set on a person, kept when not sent, cleared when blank, and shown on the rota', async () => {
  const admin = await login('admin@cafe.local');
  const staff = await login('staff1@cafe.local');
  const me = (await admin(`/users?location_id=${staff.me.location_id}`)).data.find((u) => u.id === staff.me.id);
  const put = (extra) => admin(`/users/${me.id}`, { method: 'PUT', body: { name: me.name, email: me.email, location_id: me.location_id, hourly_rate: me.hourly_rate, permission_set_id: me.access_set_id, ...extra } });
  assert.equal((await put({ rota_group: 'Kitchen' })).status, 200);
  const rota = (await admin(`/rota?location_id=${me.location_id}`)).data;
  assert.equal(rota.staff.find((u) => u.id === me.id).rota_group, 'Kitchen');
  assert.equal((await put({})).status, 200);
  assert.equal((await admin(`/rota?location_id=${me.location_id}`)).data.staff.find((u) => u.id === me.id).rota_group, 'Kitchen', 'kept when not sent');
  assert.equal((await put({ rota_group: 'x'.repeat(51) })).status, 400);
  await put({ rota_group: '' });
  assert.equal((await admin(`/rota?location_id=${me.location_id}`)).data.staff.find((u) => u.id === me.id).rota_group, null, 'cleared');
});
