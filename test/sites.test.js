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
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

test('new people can work with every site by default', async () => {
  const admin = await login('admin@cafe.local');
  const made = await admin('/users', { method: 'POST', body: { name: 'Floater', email: 'floater@cafe.local', location_id: 1, password: DEMO_PASSWORD } });
  assert.equal(made.status, 201);
  assert.equal(made.data.all_sites, 1);
  const floater = await login('floater@cafe.local');
  const sites = (await floater('/locations')).data;
  assert.equal(sites.length, 7);
  assert.equal((await floater('/rota?location_id=5')).status, 200);
  const dash = (await floater('/dashboard')).data;
  assert.equal(dash.locations.length, 7, 'the dashboard shows every site');
});

test('someone can be given a few sites, and only sees those', async () => {
  const admin = await login('admin@cafe.local');
  const m1 = (await admin('/users')).data.find((u) => u.email === 'manager1@cafe.local');
  const other = m1.location_id === 2 ? 3 : 2;
  const locked = m1.location_id === 4 ? 5 : 4;
  const r = await admin(`/users/${m1.id}`, { method: 'PUT', body: { name: m1.name, email: m1.email, location_id: m1.location_id, hourly_rate: m1.hourly_rate, all_sites: false, site_ids: [other] } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.all_sites, r.data.site_ids], [0, [other]]);
  const listed = (await admin('/users')).data.find((u) => u.id === m1.id);
  assert.deepEqual(listed.site_ids, [other]);

  const manager = await login('manager1@cafe.local');
  assert.deepEqual((await manager('/locations')).data.map((l) => l.id).sort(), [m1.location_id, other].sort());
  assert.equal((await manager(`/rota?location_id=${other}`)).status, 200);
  assert.equal((await manager(`/rota?location_id=${locked}`)).status, 403);
  assert.equal((await manager('/dashboard')).data.locations.length, 2);
  const sales = (await manager('/sales')).data;
  assert.deepEqual(sales.locations.map((l) => l.id).sort(), [m1.location_id, other].sort(), 'reports cover every site they can access');
  const rota = (await manager('/rota?location_id=all')).data;
  assert.ok(rota.shifts.length && rota.shifts.every((x) => [m1.location_id, other].includes(x.location_id)));
  // They can put someone from their own site on at the other site.
  const person = rota.staff.find((u) => u.location_id === m1.location_id && u.role === 'staff');
  assert.equal((await manager('/shifts', { method: 'POST', body: { location_id: other, user_id: person.id, date: '2032-01-05', start_time: '09:00', end_time: '12:00' } })).status, 201);
  assert.equal((await manager('/shifts', { method: 'POST', body: { location_id: locked, user_id: person.id, date: '2032-01-06', start_time: '09:00', end_time: '12:00' } })).status, 403);

  // …and only hand out sites they have themselves.
  const add = (extra) => manager('/users', { method: 'POST', body: { name: 'New', email: `n${Math.random()}@cafe.local`, location_id: m1.location_id, password: DEMO_PASSWORD, ...extra } });
  const plain = await add({});
  assert.equal(plain.status, 201);
  assert.equal(plain.data.all_sites, 0, 'people they add get their sites, not every site');
  assert.equal((await add({ all_sites: true })).status, 403);
  assert.equal((await add({ all_sites: false, site_ids: [locked] })).status, 403);
  assert.equal((await add({ all_sites: false, site_ids: [other] })).status, 201);
  assert.equal((await add({ location_id: locked })).status, 403);
});
