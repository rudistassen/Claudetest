import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

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
const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const me = async (email) => (await (await login(email))('/auth/me')).data;

test('a person can be given their own permissions instead of their set’s, and put back', async () => {
  const a = await login('admin@cafe.local');
  const s = userByEmail('staff1@cafe.local');
  const before = (await me('staff1@cafe.local')).user ?? (await me('staff1@cafe.local'));
  assert.ok(!before.permissions.includes('recipes.edit'));
  const r = await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, custom_permissions: ['rota.view', 'recipes.view', 'recipes.edit'] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.custom_access, true);
  assert.match(r.data.access_name, /own permissions/);
  const after1 = (await me('staff1@cafe.local')).user ?? (await me('staff1@cafe.local'));
  assert.deepEqual(after1.permissions, ['rota.view', 'recipes.view', 'recipes.edit']);
  // Saving other details keeps them; unknown permissions are refused.
  await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, hourly_rate: 13 } });
  assert.ok(userByEmail('staff1@cafe.local').custom_permissions);
  assert.equal((await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, custom_permissions: ['nope'] } })).status, 400);
  // null puts them back on their set.
  await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, custom_permissions: null } });
  const back = (await me('staff1@cafe.local')).user ?? (await me('staff1@cafe.local'));
  assert.ok(!back.permissions.includes('recipes.edit'));
  assert.equal(back.custom_access, false);
});

test('a manager can only tick what they can do themselves, and never managing staff', async () => {
  const mgrRow = db.prepare(`SELECT u.* FROM users u WHERE u.role = 'manager' AND u.active = 1 ORDER BY u.id`).get();
  const m = await login(mgrRow.email);
  const s = db.prepare('SELECT * FROM users WHERE role = ? AND location_id = ? AND active = 1 ORDER BY id').get('staff', mgrRow.location_id);
  const body = (perms) => ({ name: s.name, email: s.email, location_id: s.location_id, custom_permissions: perms });
  assert.equal((await m(`/users/${s.id}`, { method: 'PUT', body: body(['rota.view', 'staff.manage']) })).status, 403);
  assert.equal((await m(`/users/${s.id}`, { method: 'PUT', body: body(['rota.view', 'rota.edit']) })).status, 200);
  assert.equal(userByEmail(s.email).role, 'manager', 'editing the rota sorts them with the managers');
  // Changing their own access isn't allowed.
  assert.ok([400, 403].includes((await m(`/users/${mgrRow.id}`, { method: 'PUT', body: { name: mgrRow.name, email: mgrRow.email, location_id: mgrRow.location_id, custom_permissions: ['rota.view'] } })).status));
  assert.equal(userByEmail(mgrRow.email).custom_permissions, null);
});

test('picking new access for several people replaces their own permissions', async () => {
  const a = await login('admin@cafe.local');
  const s = userByEmail('staff1@cafe.local');
  await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, custom_permissions: ['rota.view'] } });
  const staffSet = db.prepare(`SELECT id FROM permission_sets WHERE built_in = 'staff'`).get().id;
  assert.equal((await a('/users/bulk', { method: 'POST', body: { ids: [s.id], changes: { permission_set_id: staffSet } } })).status, 200);
  assert.equal(userByEmail('staff1@cafe.local').custom_permissions, null);
  // Other bulk changes leave them alone.
  await a(`/users/${s.id}`, { method: 'PUT', body: { name: s.name, email: s.email, location_id: s.location_id, custom_permissions: ['rota.view'] } });
  await a('/users/bulk', { method: 'POST', body: { ids: [s.id], changes: { hourly_rate: 12.5 } } });
  assert.ok(userByEmail('staff1@cafe.local').custom_permissions);
});
