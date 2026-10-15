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
});
