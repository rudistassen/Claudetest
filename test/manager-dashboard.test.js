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
  return async (path) => {
    const r = await fetch(`${base}${path}`, { headers: { cookie } });
    return { status: r.status, data: await r.json() };
  };
}

test('the manager dashboard can load one site’s day; the HQ dashboard still gets every site', async () => {
  const a = await login('admin@cafe.local');
  const sites = db.prepare('SELECT id FROM locations WHERE active = 1').all();
  const all = await a('/dashboard');
  assert.equal(all.data.locations.length, sites.length);
  const one = await a(`/dashboard?location_id=${sites[1].id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.data.locations.map((l) => l.id), [sites[1].id]);
  // A manager can't load a site they don't work at.
  const m = await login('manager1@cafe.local');
  const home = db.prepare("SELECT location_id FROM users WHERE email = 'manager1@cafe.local'").get().location_id;
  const other = sites.find((s) => s.id !== home).id;
  assert.equal((await m(`/dashboard?location_id=${home}`)).data.locations[0].id, home);
  assert.equal((await m(`/dashboard?location_id=${other}`)).status, 403);
});

test('the two dashboards have their own permissions; Manager Dashboard alone only ever loads one site', async () => {
  const set = db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in = 'manager'`).get();
  const perms = JSON.parse(set.permissions);
  assert.ok(perms.includes('dashboard.view') && perms.includes('dashboard.manager'), 'managers get both by default');
  const sites = db.prepare('SELECT id FROM locations WHERE active = 1').all();
  const m = await login('manager1@cafe.local');
  const me = db.prepare("SELECT id, location_id FROM users WHERE email = 'manager1@cafe.local'").get();
  // Give this manager a second site so "all their sites" would mean more than one.
  const other = sites.find((s) => s.id !== me.location_id).id;
  db.prepare('INSERT OR IGNORE INTO user_sites (user_id, location_id) VALUES (?, ?)').run(me.id, other);
  try {
    // Only the Manager Dashboard: the dashboard data is their home site unless they pick another of theirs.
    db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify(perms.filter((p) => p !== 'dashboard.view')), set.id);
    const home = await m('/dashboard');
    assert.equal(home.status, 200);
    assert.deepEqual(home.data.locations.map((l) => l.id), [me.location_id]);
    // Neither dashboard: no dashboard data at all.
    db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify(perms.filter((p) => !p.startsWith('dashboard.'))), set.id);
    assert.equal((await m('/dashboard')).status, 403);
  } finally {
    db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(set.permissions, set.id);
  }
});
