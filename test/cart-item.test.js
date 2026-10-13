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
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

test('adding products from the search puts each in its supplier’s open cart, started if needed', async () => {
  const m = await login('manager1@cafe.local');
  const site = db.prepare(`SELECT location_id FROM users WHERE email = 'manager1@cafe.local'`).get().location_id;
  db.prepare(`DELETE FROM purchase_orders WHERE location_id = ? AND status = 'draft'`).run(site);
  const [a, b] = db.prepare('SELECT DISTINCT supplier_id FROM products WHERE active = 1 AND supplier_id IS NOT NULL ORDER BY supplier_id LIMIT 2').all().map((r) => r.supplier_id);
  const pa = db.prepare('SELECT id, unit_cost FROM products WHERE supplier_id = ? AND active = 1 ORDER BY id LIMIT 2').all(a);
  const pb = db.prepare('SELECT id FROM products WHERE supplier_id = ? AND active = 1 ORDER BY id LIMIT 1').get(b);
  const set = (product_id, quantity) => m('/orders/cart-item', { method: 'POST', body: { location_id: site, product_id, quantity } });

  let r = await set(pa[0].id, 2);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.length, 1);
  const cartA = r.data[0];
  assert.equal(cartA.supplier_id, a);
  assert.deepEqual(cartA.lines, [{ product_id: pa[0].id, quantity: 2 }]);
  r = await set(pa[1].id, 1);
  r = await set(pb.id, 3);
  assert.equal(r.data.length, 2, 'one cart per supplier');
  assert.equal(r.data.find((c) => c.supplier_id === a).id, cartA.id, 'the same cart is added to');
  assert.equal(r.data.find((c) => c.supplier_id === a).lines.length, 2);

  // Changing and removing; a cart left empty goes.
  r = await set(pa[0].id, 5);
  assert.equal(r.data.find((c) => c.id === cartA.id).lines.find((l) => l.product_id === pa[0].id).quantity, 5);
  await set(pa[0].id, 0);
  r = await set(pa[1].id, 0);
  assert.ok(!r.data.some((c) => c.id === cartA.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE id = ?').get(cartA.id).n, 0);
  assert.equal((await m(`/orders/carts?location_id=${site}`)).data.length, 1);

  // Sent orders aren't added to: a new cart is started instead.
  const cartB = r.data[0].id;
  db.prepare(`UPDATE purchase_orders SET status = 'sent' WHERE id = ?`).run(cartB);
  r = await set(pb.id, 1);
  assert.notEqual(r.data[0].id, cartB);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE order_id = ?').get(cartB).n, 1, 'the sent order is unchanged');

  // Staff can't.
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/orders/cart-item', { method: 'POST', body: { location_id: site, product_id: pb.id, quantity: 1 } })).status, 403);
});
