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

test('skills areas: people come with their rota role, and the rota shows what each person is trained in', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'manager1@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = async (path) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();
  const me = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  db.prepare(`UPDATE users SET rota_group = 'Front of house' WHERE id = ?`).run(me.id);
  const barista = Number(db.prepare(`INSERT INTO work_areas (name) VALUES ('Barista')`).run().lastInsertRowid);
  const kitchen = Number(db.prepare(`INSERT INTO work_areas (name) VALUES ('Kitchen')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO user_areas (user_id, area_id, level) VALUES (?, ?, 'trained'), (?, ?, 'learning')`).run(me.id, barista, me.id, kitchen);

  const areas = await get(`/areas?location_id=${me.location_id}`);
  assert.equal(areas.people.find((p) => p.id === me.id).rota_group, 'Front of house');

  const rota = await get(`/rota?location_id=${me.location_id}`);
  const row = rota.staff.find((u) => u.id === me.id);
  // Only what they're trained in (not still learning).
  assert.deepEqual(row.skills, ['Barista']);

  // Staff don't see skills on the rota (rota.skills is for whoever sets it).
  const res2 = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@cafe.local', password: DEMO_PASSWORD }) });
  const staffCookie = res2.headers.get('set-cookie').split(';')[0];
  const staffRota = await (await fetch(`${base}/rota?location_id=${me.location_id}`, { headers: { cookie: staffCookie } })).json();
  assert.ok(staffRota.staff.every((u) => !u.skills.length), 'no skills for staff');
});

test('include on rota: everyone starts on it; untick someone and they drop off the rota (unless they have a shift that week)', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, method = 'GET', body) => (await fetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE on_rota = 0').get().n, 0, 'everyone ticked to start with');
  const u = db.prepare(`SELECT * FROM users WHERE email = 'staff1@cafe.local'`).get();
  const week = '2030-01-07'; // a week with no shifts
  const before = await call(`/rota?location_id=${u.location_id}&week=${week}`);
  assert.ok(before.staff.some((s) => s.id === u.id));
  const saved = await call(`/users/${u.id}`, 'PUT', { name: u.name, email: u.email, location_id: u.location_id, permission_set_id: u.permission_set_id, on_rota: false });
  assert.equal(saved.on_rota, 0);
  const after = await call(`/rota?location_id=${u.location_id}&week=${week}`);
  assert.ok(!after.staff.some((s) => s.id === u.id), 'off the rota');
  // Saving the form without the tick (older screens) leaves it as it is.
  await call(`/users/${u.id}`, 'PUT', { name: u.name, email: u.email, location_id: u.location_id, permission_set_id: u.permission_set_id });
  assert.equal(db.prepare('SELECT on_rota FROM users WHERE id = ?').get(u.id).on_rota, 0);
});

test('forecast sales and labour % on the rota have their own permission (rota.costs)', async () => {
  const login = async (email) => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (path) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();
  };
  const u = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view']), u.id);
  let rota = await (await login('staff1@cafe.local'))(`/rota?location_id=${u.location_id}`);
  assert.equal(rota.forecast, undefined, 'not without it');
  assert.equal(rota.labour_cost, undefined);
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view', 'rota.costs']), u.id);
  rota = await (await login('staff1@cafe.local'))(`/rota?location_id=${u.location_id}`);
  assert.ok(rota.forecast, 'forecast sales with it');
  assert.equal(typeof rota.labour_cost, 'number');
  db.prepare('UPDATE users SET custom_permissions = NULL WHERE id = ?').run(u.id);
});
