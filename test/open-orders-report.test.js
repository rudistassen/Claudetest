import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient } from '../src/square.js';

// A pretend Square with an open tab at two sites and a payment link order.
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const gbp = (amount) => ({ amount, currency: 'GBP' });
let orders = [];
async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/v2/orders/search') {
    const q = JSON.parse(init.body);
    const { start_at: start, end_at: end } = q.query.filter.date_time_filter.created_at;
    return json(200, { orders: orders.filter((o) => q.location_ids.includes(o.location_id) && o.created_at >= start && o.created_at < end) });
  }
  const one = orders.find((o) => path === `/v2/orders/${o.id}`);
  return one ? json(200, { order: one }) : json(404, { errors: [{ detail: 'Not found' }] });
}

let server;
let base;
let db;
let sites;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_' || id`).run();
  sites = db.prepare('SELECT id FROM locations ORDER BY id').all().map((r) => r.id);
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  orders = [
    { id: 'T1', location_id: `SQ_${sites[0]}`, state: 'OPEN', created_at: ago(30), ticket_name: 'Table 4',
      line_items: [{ name: 'Flat white', quantity: '2', modifiers: [{ name: 'Oat milk' }], total_money: gbp(720) }, { name: 'Toastie', quantity: '1', note: 'No butter', total_money: gbp(850) }],
      discounts: [{ name: 'Staff', applied_money: gbp(100) }], total_money: gbp(1470), total_tax_money: gbp(245), tenders: [{ amount_money: gbp(500) }], net_amount_due_money: gbp(970) },
    { id: 'T2', location_id: `SQ_${sites[1]}`, state: 'OPEN', created_at: ago(3 * 1440), line_items: [{ name: 'Cake', quantity: '1', total_money: gbp(400) }], total_money: gbp(400) },
    { id: 'WEB1', location_id: `SQ_${sites[0]}`, state: 'OPEN', created_at: ago(15), source: { name: 'Square Online' }, line_items: [{ name: 'Cake', quantity: '1', total_money: gbp(400) }], total_money: gbp(400) },
    { id: 'APP1', location_id: `SQ_${sites[0]}`, state: 'OPEN', created_at: ago(12), fulfillments: [{ type: 'DELIVERY' }], line_items: [{ name: 'Cake', quantity: '1', total_money: gbp(400) }], total_money: gbp(400) },
    { id: 'PL1', location_id: `SQ_${sites[0]}`, state: 'OPEN', created_at: ago(20), line_items: [{ name: 'Deposit', quantity: '1', total_money: gbp(5000) }], total_money: gbp(5000) },
  ];
  db.prepare(`INSERT INTO payment_links (location_id, square_link_id, square_order_id, url, amount, description) VALUES (?, 'L', 'PL1', 'u', 50, 'deposit')`).run(sites[0]);
  const config = { token: 't', environment: 'production', baseUrl: 'https://square.test', version: '2025-01-23' };
  server = createApp(db, { square: { config, client: new SquareClient(config, fakeFetch) } }).listen(0);
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

test('open orders report: lists unpaid tabs (not payment links or online orders), newest first, with details on request', async () => {
  const admin = await login('admin@cafe.local');
  const all = (await admin('/open-orders')).data;
  assert.deepEqual(all.orders.map((o) => [o.id, o.name, o.amount, o.due, o.items]), [['T1', 'Table 4', 14.7, 9.7, 3], ['T2', null, 4, 4, 1]]);
  assert.deepEqual((await admin('/open-orders?days=1')).data.orders.map((o) => o.id), ['T1'], 'only today’s');
  assert.deepEqual((await admin(`/open-orders?location_id=${sites[1]}`)).data.orders.map((o) => o.id), ['T2']);

  const detail = (await admin('/open-orders/T1')).data;
  assert.deepEqual(detail.lines, [
    { name: 'Flat white', variation: null, quantity: 2, options: ['Oat milk'], note: null, total: 7.2 },
    { name: 'Toastie', variation: null, quantity: 1, options: [], note: 'No butter', total: 8.5 },
  ]);
  assert.deepEqual([detail.discounts, detail.total, detail.tax, detail.paid, detail.due], [[{ name: 'Staff', amount: 1 }], 14.7, 2.45, 5, 9.7]);
  assert.equal((await admin('/open-orders/nope')).status, 404);
});

test('open orders report: only for people who see sales, and only their own sites’ orders', async () => {
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/open-orders')).status, 403);
  const manager = await login('manager1@cafe.local');
  const mine = db.prepare(`SELECT location_id FROM users WHERE email = 'manager1@cafe.local'`).get().location_id;
  const theirs = (await manager('/open-orders')).data.orders;
  assert.ok(theirs.every((o) => o.location_id === mine));
  const other = orders.find((o) => o.location_id !== `SQ_${mine}` && o.id.startsWith('T'));
  assert.equal((await manager(`/open-orders/${other.id}`)).status, 404, 'another site’s order stays hidden');
});
