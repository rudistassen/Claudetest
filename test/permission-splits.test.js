import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { ALL_PERMISSIONS, PERMISSION_SPLITS } from '../src/permissions.js';
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
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
// Gives staff1 exactly these permissions (their own custom permissions) and signs them in.
const staff1 = () => db.prepare(`SELECT * FROM users WHERE email = 'staff1@cafe.local'`).get();
async function as(perms) {
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(perms), staff1().id);
  return login('staff1@cafe.local');
}

test('every new permission is in the list, and the splits only name real permissions', () => {
  for (const [old, list] of Object.entries(PERMISSION_SPLITS)) {
    for (const p of list) assert.ok(ALL_PERMISSIONS.includes(p), `${old} → ${p}`);
  }
  assert.ok(!ALL_PERMISSIONS.includes('people.manage'), 'people.manage was split into four');
});

test('upgrading keeps what every set and custom-permission person could do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-perms-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    const old = ['people.manage', 'orders.manage', 'leave.manage', 'rota.publish', 'sales.view', 'staff.manage', 'events.manage', 'news.manage'];
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Old supervisor', '', ?)`).run(JSON.stringify(old));
    d.prepare(`INSERT INTO users (name, email, password_hash, role, custom_permissions) VALUES ('Custom', 'c@x', 'x', 'staff', ?)`).run(JSON.stringify(['people.manage', 'dashboard.view']));
    d.exec('PRAGMA user_version = 12');
    d.close();
    d = openDb(file);
    const set = JSON.parse(d.prepare(`SELECT permissions FROM permission_sets WHERE name = 'Old supervisor'`).get().permissions);
    for (const p of Object.values(PERMISSION_SPLITS).flat()) assert.ok(set.includes(p), p);
    const custom = JSON.parse(d.prepare(`SELECT custom_permissions FROM users WHERE email = 'c@x'`).get().custom_permissions);
    for (const p of ['people.recruitment', 'people.training', 'people.performance', 'people.areas', 'dashboard.manager']) assert.ok(custom.includes(p), p);
    assert.ok(!custom.includes('orders.manage'), 'nothing extra');
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each part of People has its own permission', async () => {
  const s = await as(['people.training']);
  assert.equal((await s('/training')).status, 200);
  assert.equal((await s('/training/designs')).status, 200);
  assert.equal((await s('/vacancies')).status, 403);
  assert.equal((await s('/performance')).status, 403);
  assert.equal((await s('/areas')).status, 403);
  const r = await as(['people.recruitment']);
  assert.equal((await r('/vacancies')).status, 200);
  assert.equal((await r('/training')).status, 403);
});

test('approving holiday, changing people’s holiday and seeing availability are separate', async () => {
  const approve = await as(['leave.manage']);
  assert.equal((await approve('/leave')).status, 200);
  assert.equal((await approve('/leave/people')).status, 403);
  assert.equal((await approve('/availability')).status, 403);
  const edit = await as(['leave.edit']);
  assert.equal((await edit('/leave/people')).status, 200);
  assert.equal((await edit('/leave/1/decide', { method: 'POST', body: { status: 'approved' } })).status, 403);
  const avail = await as(['availability.view']);
  assert.equal((await avail('/availability')).status, 200);
});

test('pay rates need their own permission: hidden and left alone without it', async () => {
  const person = db.prepare(`SELECT * FROM users WHERE email = 'staff2@cafe.local'`).get();
  db.prepare('UPDATE users SET location_id = ? WHERE id = ?').run(person.location_id, staff1().id);
  // A manager without the pay permission.
  const managerPerms = JSON.parse(db.prepare(`SELECT permissions FROM permission_sets WHERE built_in = 'manager'`).get().permissions);
  const s = await as(managerPerms.filter((p) => p !== 'staff.pay'));
  const list = (await s('/users')).data;
  assert.ok(list.length && list.every((u) => u.hourly_rate === undefined), 'no pay rates shown');
  const put = await s(`/users/${person.id}`, { method: 'PUT', body: { name: person.name, email: person.email, location_id: person.location_id, hourly_rate: 99, permission_set_id: person.permission_set_id } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(db.prepare('SELECT hourly_rate FROM users WHERE id = ?').get(person.id).hourly_rate, person.hourly_rate, 'pay unchanged');
  const pay = await as(managerPerms);
  assert.ok((await pay('/users')).data.some((u) => u.hourly_rate !== undefined));
});

test('approving shift drops and pick-ups is separate from publishing', async () => {
  const pub = await as(['rota.view', 'rota.publish']);
  assert.deepEqual((await pub('/shift-drops')).data.to_approve, []);
  assert.equal((await pub('/shift-drops/1/approve', { method: 'POST' })).status, 403);
});

test('the Claude rota tools and the Staff log can be given to non-admins', async () => {
  const m = await login('manager1@cafe.local');
  assert.equal((await m('/rota/analyses/latest')).status, 403, 'managers don’t get them by default');
  assert.equal((await m('/staff-log')).status, 403);
  const s = await as(['rota.view', 'rota.ai', 'staff.log']);
  assert.equal((await s('/rota/analyses/latest')).status, 200);
  const log = await s('/staff-log');
  assert.equal(log.status, 200);
  // Only people at their own sites, never admins.
  const mySites = new Set([staff1().location_id]);
  const people = db.prepare('SELECT id, location_id, role FROM users').all();
  for (const p of log.data.people) {
    const u = people.find((x) => x.id === p.id);
    assert.ok(u.role !== 'admin' && mySites.has(u.location_id), `${p.name} shouldn’t be in their log`);
  }
});
