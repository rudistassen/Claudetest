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
  const body = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body: b } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.user = body.user;
  return call;
}

test('built-in Manager and Staff sets keep what each role could do before', async () => {
  const admin = await login('admin@cafe.local');
  const { areas, sets } = (await admin('/permissions')).data;
  assert.ok(areas.length >= 8);
  const manager = sets.find((s) => s.built_in === 'manager');
  const staff = sets.find((s) => s.built_in === 'staff');
  assert.ok(manager.permissions.includes('staff.manage') && !manager.permissions.includes('recipes.edit'));
  assert.deepEqual(staff.permissions.sort(), ['recipes.view', 'rota.view', 'safety.complete', 'stock.count', 'wastage.record', 'wastage.reports']);
  assert.ok(manager.people >= 7 && staff.people > 7, 'everyone without a set counts under their role’s set');

  const s1 = await login('staff1@cafe.local');
  assert.equal(s1.user.access_name, 'Staff');
  assert.ok(s1.user.permissions.includes('rota.view'));
  assert.equal(admin.user.access_name, 'Admin');
  assert.ok(admin.user.permissions.includes('setup.products'), 'admins have everything');
});

test('a custom set controls what someone can do, and changes apply straight away', async () => {
  const admin = await login('admin@cafe.local');
  assert.equal((await admin('/permission-sets', { method: 'POST', body: { name: 'admin', permissions: [] } })).status, 400, '“Admin” is reserved');
  const created = await admin('/permission-sets', { method: 'POST', body: { name: 'Supervisor', description: 'Runs a shift', permissions: ['rota.view', 'rota.edit', 'safety.complete', 'made.up'] } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.permissions, ['safety.complete', 'rota.view', 'rota.edit'], 'unknown permissions are dropped');

  const staff2 = (await admin('/users')).data.find((u) => u.email === 'staff2@cafe.local');
  const assigned = await admin(`/users/${staff2.id}`, { method: 'PUT', body: { name: staff2.name, email: staff2.email, location_id: staff2.location_id, hourly_rate: staff2.hourly_rate, permission_set_id: created.data.id } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.access_name, 'Supervisor');
  assert.equal(assigned.data.role, 'manager', 'sorted with managers because they can edit the rota');

  const sup = await login('staff2@cafe.local');
  assert.equal((await sup('/shifts', { method: 'POST', body: { user_id: staff2.id, date: '2031-03-03', start_time: '09:00', end_time: '12:00' } })).status, 201);
  assert.equal((await sup('/wastage')).status, 403, 'no wastage permission');
  assert.equal((await sup('/sales')).status, 403);
  assert.equal((await sup('/orders')).status, 403);
  assert.equal((await sup('/users')).status, 403);
  const rota = (await sup('/rota')).data;
  assert.equal(rota.labour_cost, undefined, 'no pay or labour costs without sales or staff permission');

  // Taking rota.edit away works on their next request.
  await admin(`/permission-sets/${created.data.id}`, { method: 'PUT', body: { name: 'Supervisor', permissions: ['rota.view', 'safety.complete'] } });
  assert.equal((await sup('/shifts', { method: 'POST', body: { user_id: staff2.id, date: '2031-03-04', start_time: '09:00', end_time: '12:00' } })).status, 403);

  assert.equal((await admin(`/permission-sets/${created.data.id}`, { method: 'DELETE' })).status, 400, 'in use');
  const builtIn = (await admin('/permissions')).data.sets.find((s) => s.built_in === 'staff');
  assert.equal((await admin(`/permission-sets/${builtIn.id}`, { method: 'DELETE' })).status, 400, 'built in');
  const spare = await admin('/permission-sets', { method: 'POST', body: { name: 'Spare', permissions: [] } });
  assert.equal((await admin(`/permission-sets/${spare.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await sup('/permission-sets', { method: 'POST', body: { name: 'Sneaky', permissions: ['sales.view'] } })).status, 403, 'only admins edit sets');
});

test('people who manage staff only hand out access they have, and never staff management', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager3@cafe.local');
  const site = manager.user.location_id;
  const sets = (await manager('/permissions')).data.sets;
  const mgrSet = sets.find((s) => s.built_in === 'manager');
  const staffSet = sets.find((s) => s.built_in === 'staff');
  assert.equal(mgrSet.assignable, false);
  assert.equal(staffSet.assignable, true);
  const body = (extra) => ({ name: 'New Person', email: `np${Math.random()}@cafe.local`, location_id: site, password: 'password123', ...extra });

  assert.equal((await manager('/users', { method: 'POST', body: body({ permission_set_id: staffSet.id }) })).status, 201);
  assert.equal((await manager('/users', { method: 'POST', body: body({ permission_set_id: mgrSet.id }) })).status, 403);
  assert.equal((await manager('/users', { method: 'POST', body: body({ permission_set_id: 'admin' }) })).status, 403);
  const recipesEditor = (await admin('/permission-sets', { method: 'POST', body: { name: 'Recipe editor', permissions: ['recipes.view', 'recipes.edit'] } })).data;
  const r = await manager('/users', { method: 'POST', body: body({ permission_set_id: recipesEditor.id }) });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /access you have yourself/);
  // An admin can.
  assert.equal((await admin('/users', { method: 'POST', body: body({ permission_set_id: recipesEditor.id }) })).status, 201);
});

test('seeing the dashboard: kept for managers and custom sets when added, off for the built-in Staff set', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb: open } = await import('../src/db.js');
  const dir = mkdtempSync(join(tmpdir(), 'brewly-'));
  try {
    const file = join(dir, 'app.db');
    // A database from before the permission existed.
    let db = open(file);
    const strip = (where) => {
      for (const ps of db.prepare(`SELECT id, permissions FROM permission_sets WHERE ${where}`).all()) {
        db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify(JSON.parse(ps.permissions).filter((p) => p !== 'dashboard.view')), ps.id);
      }
    };
    db.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Supervisor', '', '["rota.view"]')`).run();
    strip('1 = 1');
    db.exec('PRAGMA user_version = 4');
    db.close();
    db = open(file);
    const has = (where) => JSON.parse(db.prepare(`SELECT permissions FROM permission_sets WHERE ${where}`).get().permissions).includes('dashboard.view');
    assert.equal(has(`built_in = 'manager'`), true);
    assert.equal(has(`name = 'Supervisor'`), true);
    assert.equal(has(`built_in = 'staff'`), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
