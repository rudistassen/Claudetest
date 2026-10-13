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
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

test('sites order prepped recipes for a day; the prep list adds them up in batches', async () => {
  const a = await login('admin@cafe.local');
  const [s1, s2] = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 2').all().map((r) => r.id);
  const egg = db.prepare(`SELECT id FROM recipes WHERE name = 'Egg mayo filling'`).get().id; // a batch makes 480 g
  const sold = db.prepare(`SELECT id FROM recipes WHERE kind = 'sold' LIMIT 1`).get().id;
  const day = tomorrow();
  const list = (await a('/prep-orders')).data;
  assert.ok(list.recipes.some((r) => r.id === egg && r.yield_unit === 'g'));
  assert.ok(!list.recipes.some((r) => r.id === sold), 'only prepped recipes can be ordered');

  const o1 = await a('/prep-orders', { method: 'POST', body: { location_id: s1, needed_on: day, lines: [{ recipe_id: egg, quantity: 600 }] } });
  assert.equal(o1.status, 201);
  assert.equal((await a('/prep-orders', { method: 'POST', body: { location_id: s2, needed_on: day, notes: 'Before 10', lines: [{ recipe_id: egg, quantity: 400 }] } })).status, 201);
  assert.equal((await a('/prep-orders', { method: 'POST', body: { location_id: s1, needed_on: day, lines: [{ recipe_id: sold, quantity: 1 }] } })).status, 404);
  assert.equal((await a('/prep-orders', { method: 'POST', body: { location_id: s1, needed_on: day, lines: [{ recipe_id: egg, quantity: 0 }] } })).status, 400);

  let pl = (await a(`/prep-orders/list?date=${day}`)).data;
  const item = pl.items.find((i) => i.recipe_id === egg);
  assert.equal(item.total, 1000);
  assert.equal(item.batches_to_make, 3, '1000 g ÷ 480 g a batch, rounded up');
  assert.equal(item.sites.length, 2);

  // Changed while it's still ordered; once sent it's fixed.
  assert.equal((await a(`/prep-orders/${o1.data.id}`, { method: 'PUT', body: { lines: [{ recipe_id: egg, quantity: 360 }] } })).status, 200);
  pl = (await a(`/prep-orders/list?date=${day}`)).data;
  assert.equal(pl.items.find((i) => i.recipe_id === egg).batches_to_make, 2);
  assert.equal((await a(`/prep-orders/${o1.data.id}/sent`, { method: 'POST', body: {} })).data.status, 'sent');
  assert.equal((await a(`/prep-orders/${o1.data.id}`, { method: 'PUT', body: { lines: [{ recipe_id: egg, quantity: 1 }] } })).status, 400);
  assert.equal((await a(`/prep-orders/${o1.data.id}`, { method: 'DELETE' })).status, 400);

  // Staff without ordering can't use it.
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/prep-orders')).status, 403);
});

test('the prep list shows every day with orders at once', async () => {
  const a = await login('admin@cafe.local');
  const site = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1').get().id;
  const egg = db.prepare(`SELECT id FROM recipes WHERE name = 'Egg mayo filling'`).get().id;
  const from = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.parse(`${from}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  for (const [n, q] of [[0, 300], [2, 500], [9, 700]]) {
    assert.equal((await a('/prep-orders', { method: 'POST', body: { location_id: site, needed_on: plus(n), lines: [{ recipe_id: egg, quantity: q }] } })).status, 201);
  }
  const r = (await a(`/prep-orders/lists?from=${from}&days=8`)).data;
  assert.equal(r.to, plus(7));
  assert.deepEqual(r.days.map((d) => d.date), [plus(0), plus(2)], 'only days with orders, within the 8 days');
  assert.equal(r.days[1].items[0].total, 500);
  assert.equal((await a(`/prep-orders/lists?from=${plus(7)}&days=8`)).data.days.map((d) => d.date).join(), plus(9));
});
