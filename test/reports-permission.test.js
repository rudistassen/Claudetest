import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { ALL_PERMISSIONS, DEFAULT_SETS } from '../src/permissions.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

const REPORTS = ['reports.trading', 'reports.sales', 'reports.open_orders', 'reports.rota_costs', 'reports.par_levels', 'reports.breaks', 'reports.sickness', 'reports.reviews'];

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

test('each report is its own permission; the Manager set has them all and Staff none', () => {
  for (const r of REPORTS) assert.ok(ALL_PERMISSIONS.includes(r), r);
  assert.ok(!ALL_PERMISSIONS.includes('reports.view'));
  const manager = DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions;
  for (const r of REPORTS) assert.ok(manager.includes(r), r);
  assert.ok(!DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions.some((p) => p.startsWith('reports.')));
});

test('a report’s permission is enough to open it, and only it', async () => {
  const person = db.prepare(`SELECT id FROM users WHERE email = 'staff1@cafe.local'`).get().id;
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view', 'reports.trading', 'reports.sickness']), person);
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const status = async (path) => (await fetch(`${base}${path}`, { headers: { cookie } })).status;
  assert.equal(await status('/trading'), 200);
  assert.equal(await status('/trading/heatmap'), 200);
  assert.equal(await status('/reports/sickness'), 200);
  assert.equal(await status('/sales'), 403);
  assert.equal(await status('/open-orders'), 403);
  assert.equal(await status('/reports/rota-costs'), 403);
  assert.equal(await status('/par-levels'), 403);
  assert.equal(await status('/breaks'), 403);
  assert.equal(await status('/reviews'), 403);
});

test('upgrading turns the old Reporting menu permission into each report people could open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-reports-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES
      ('Sales', '', '["reports.view","sales.view"]'), ('Sick', '', '["reports.view","rota.edit"]'), ('No menu', '', '["sales.view"]')`).run();
    d.prepare(`INSERT INTO users (name, email, password_hash, role, custom_permissions) VALUES ('Custom', 'c@x', 'x', 'staff', '["reports.view","reviews.view"]')`).run();
    d.exec('PRAGMA user_version = 17');
    d.close();
    d = openDb(file);
    const set = (name) => JSON.parse(d.prepare('SELECT permissions FROM permission_sets WHERE name = ?').get(name).permissions);
    assert.deepEqual(set('Sales').filter((p) => p.startsWith('reports.')).sort(), ['reports.breaks', 'reports.open_orders', 'reports.par_levels', 'reports.rota_costs', 'reports.sales', 'reports.trading']);
    assert.deepEqual(set('Sick').filter((p) => p.startsWith('reports.')).sort(), ['reports.sickness']);
    assert.ok(!set('No menu').some((p) => p.startsWith('reports.')), 'no Reporting menu before, no reports now');
    const custom = JSON.parse(d.prepare(`SELECT custom_permissions FROM users WHERE email = 'c@x'`).get().custom_permissions);
    assert.deepEqual(custom.filter((p) => p.startsWith('reports.')), ['reports.reviews']);
    for (const r of REPORTS) assert.ok(set('Manager').includes(r), `built-in Manager: ${r}`);
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('My Atlas, Time off and My availability are permissions everyone keeps on upgrading', async () => {
  for (const p of ['mybrew.view', 'leave.request', 'availability.own']) {
    assert.ok(ALL_PERMISSIONS.includes(p), p);
    assert.ok(DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions.includes(p), `Staff: ${p}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'atlas-menu-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Floor', '', '["rota.view"]')`).run();
    d.exec('PRAGMA user_version = 18');
    d.close();
    d = openDb(file);
    const floor = JSON.parse(d.prepare(`SELECT permissions FROM permission_sets WHERE name = 'Floor'`).get().permissions);
    for (const p of ['mybrew.view', 'leave.request', 'availability.own']) assert.ok(floor.includes(p), p);
    d.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // Without them: no holiday requests or own availability.
  const person = db.prepare(`SELECT id FROM users WHERE email = 'staff1-2@cafe.local'`).get().id;
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view']), person);
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1-2@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/leave', { start_date: day, end_date: day })).status, 403);
  assert.equal((await post('/availability/days', { date: day, kind: 'unavailable', all_day: true })).status, 403);
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view', 'leave.request', 'availability.own']), person);
  assert.equal((await post('/leave', { start_date: day, end_date: day })).status, 201);
  assert.notEqual((await post('/availability/days', { date: day, kind: 'unavailable', all_day: true })).status, 403);
});
