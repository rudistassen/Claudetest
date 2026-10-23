import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { applyCleanup, planCleanup } from '../src/cleanup.js';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let dir;
let db;
let server;
let base;
let adminId;
let keepSite;
let keptStaff;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-cleanup-'));
  db = openDb(path.join(dir, 'cafe.db'));
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@cafe.local'`).get().id;
  keepSite = db.prepare(`SELECT id FROM locations WHERE name = 'High Street'`).get().id;
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_HIGH' WHERE id = ?`).run(keepSite);
  // Square has manager1 (High Street) and one person whose home site is Harbour, which isn't linked.
  keptStaff = db.prepare(`SELECT id FROM users WHERE email IN ('manager1@cafe.local', 'staff2@cafe.local') ORDER BY email`).all().map((u) => u.id);
  db.prepare(`INSERT INTO square_team_members (id, name, user_id) VALUES ('TM_A', 'A', ?), ('TM_B', 'B', ?)`).run(...keptStaff);
  // A wastage record at the kept site entered by someone who'll be removed.
  const leaver = db.prepare(`SELECT id FROM users WHERE location_id = ? AND id NOT IN (?, ?) LIMIT 1`).get(keepSite, ...keptStaff).id;
  db.prepare(`INSERT INTO wastage (location_id, item_name, quantity, reason, date, recorded_by) VALUES (?, 'Milk', 1, 'Out of date', '2026-01-01', ?)`).run(keepSite, leaver);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('previews, then removes sites not linked to Square and staff not in Square', async () => {
  const plan = planCleanup(db, { currentUserId: adminId });
  assert.equal(plan.ready, true);
  assert.equal(plan.locations.length, 6);
  assert.ok(!plan.locations.some((l) => l.id === keepSite));
  assert.ok(plan.locations.every((l) => l.shifts > 0));
  assert.ok(!plan.staff.some((u) => u.id === adminId), 'never removes you');
  assert.ok(!plan.staff.some((u) => keptStaff.includes(u.id)));
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to_location_id]), [[keptStaff[1], keepSite]], 'staff2 is in Square but based at Harbour');
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const r = applyCleanup(db, { currentUserId: adminId, removeLocations: true, removeStaff: true });
  assert.equal(r.locations_removed, 6);
  assert.equal(r.staff_removed, usersBefore - 3);
  assert.match(r.backup, /^cafe-before-cleanup-\d{8}-\d{6}\.db$/);
  const backup = openDb(path.join(dir, r.backup));
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore, 'the backup has everything');
  backup.close();

  assert.deepEqual(db.prepare('SELECT id FROM locations').all().map((l) => l.id), [keepSite]);
  assert.deepEqual(db.prepare('SELECT id FROM users ORDER BY id').all().map((u) => u.id), [adminId, ...keptStaff].sort((a, b) => a - b));
  assert.equal(db.prepare('SELECT location_id FROM users WHERE id = ?').get(keptStaff[1]).location_id, keepSite);
  assert.equal(db.prepare(`SELECT recorded_by FROM wastage WHERE item_name = 'Milk' AND date = '2026-01-01'`).get().recorded_by, null, 'their records stay, unnamed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE location_id != ?').get(keepSite).n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // The app still works for the people who are left.
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'manager1@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  for (const p of ['/dashboard', '/rota', '/wastage', '/trading', '/trading/heatmap', '/users']) {
    assert.equal((await fetch(`${base}${p}`, { headers: { cookie } })).status, 200, p);
  }
  assert.equal((await fetch(`${base}/square/cleanup`, { headers: { cookie } })).status, 403, 'admins only');
});

test('refuses to remove everyone before staff are imported from Square', () => {
  const mem = openDb(':memory:');
  seedAdmin(mem, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(mem);
  const me = mem.prepare(`SELECT id FROM users WHERE email = 'admin@cafe.local'`).get().id;
  assert.equal(planCleanup(mem, { currentUserId: me }).ready, false);
  assert.throws(() => applyCleanup(mem, { currentUserId: me, removeLocations: true }), /Link at least one site/);
  mem.prepare(`UPDATE locations SET square_location_id = 'SQ_X' WHERE id = (SELECT MIN(id) FROM locations)`).run();
  assert.throws(() => applyCleanup(mem, { currentUserId: me, removeStaff: true }), /Import your staff from Square first/);
  assert.equal(mem.prepare('SELECT COUNT(*) AS n FROM users').get().n > 10, true, 'nothing was deleted');
});
