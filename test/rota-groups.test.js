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

test('bulk editing staff: only what is picked changes, everyone is checked, and it is all or nothing', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const all = (await admin('/users')).data;
  const mySite = manager.me.location_id;
  const mine = all.filter((u) => u.location_id === mySite && u.role === 'staff').slice(0, 2);
  const elsewhere = all.find((u) => u.location_id !== mySite && u.role === 'staff');
  const before = mine.map((u) => ({ ...u }));
  const bulk = (who, ids, changes) => who('/users/bulk', { method: 'POST', body: { ids, changes } });

  assert.equal((await bulk(admin, [], { rota_group: 'Kitchen' })).status, 400, 'nobody chosen');
  assert.equal((await bulk(admin, [mine[0].id], {})).status, 400, 'nothing to change');
  assert.equal((await bulk(await staffLogin(), [mine[0].id], { rota_group: 'x' })).status, 403, 'staff can’t');

  const ok = await bulk(manager, mine.map((u) => u.id), { rota_group: 'Front of house', hourly_rate: 12.5 });
  assert.deepEqual([ok.status, ok.data.updated], [200, 2]);
  const after = (await admin('/users')).data.filter((u) => mine.some((m) => m.id === u.id));
  for (const u of after) {
    const was = before.find((b) => b.id === u.id);
    assert.deepEqual([u.rota_group, u.hourly_rate], ['Front of house', 12.5]);
    assert.deepEqual([u.name, u.email, u.location_id, u.access_set_id, u.active, u.all_sites], [was.name, was.email, was.location_id, was.access_set_id, was.active, was.all_sites], 'nothing else changed');
  }

  // Someone at a site the manager can't manage: refused with their name, and nobody is changed.
  const refused = await bulk(manager, [mine[0].id, elsewhere.id], { rota_group: 'Bar' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, new RegExp(elsewhere.name));
  assert.equal((await admin('/users')).data.find((u) => u.id === mine[0].id).rota_group, 'Front of house');

  assert.equal((await bulk(admin, [admin.me.id], { active: false })).status, 400, 'can’t deactivate yourself');
  const off = await bulk(admin, [mine[1].id], { active: false, rota_group: null });
  assert.equal(off.status, 200);
  const gone = (await admin('/users')).data.find((u) => u.id === mine[1].id);
  assert.deepEqual([gone.active, gone.rota_group], [0, null]);
});

function staffLogin() { return login('staff1@cafe.local'); }
