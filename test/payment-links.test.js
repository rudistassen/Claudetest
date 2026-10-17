import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { memoryMailer } from '../src/email.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient } from '../src/square.js';

// A pretend Square, recording what Atlas asks it.
const calls = [];
let paid = false;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  if (path === '/v2/online-checkout/payment-links') return json(200, { payment_link: { id: `PL${calls.length}`, order_id: `O${calls.length}`, url: `https://square.link/u/x${calls.length}` } });
  if (path.startsWith('/v2/online-checkout/payment-links/')) return json(200, {});
  if (path.startsWith('/v2/orders/')) return json(200, { order: { state: paid ? 'COMPLETED' : 'OPEN', tenders: paid ? [{}] : [], net_amount_due_money: { amount: paid ? 0 : 5000 } } });
  return json(404, { errors: [{ detail: 'nope' }] });
}

let server;
let base;
let db;
const mailer = memoryMailer();
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_' || id`).run();
  const config = { token: 't', environment: 'production', baseUrl: 'https://square.test', version: '2025-01-23' };
  server = createApp(db, { square: { config, client: new SquareClient(config, fakeFetch) }, mailer }).listen(0);
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

test('payment links: created in Square for the site, emailed, shown as paid, and only for people allowed', async () => {
  const manager = await login('manager1@cafe.local');
  assert.equal((await manager('/payment-links')).status, 403, 'not given to managers unless an admin ticks it');

  const admin = await login('admin@cafe.local');
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  assert.equal((await admin('/payment-links', { method: 'POST', body: { location_id: site, amount: 0.5, description: 'x' } })).status, 400);
  assert.equal((await admin('/payment-links', { method: 'POST', body: { location_id: site, amount: 12.345, description: 'x' } })).status, 400);
  const made = await admin('/payment-links', { method: 'POST', body: { location_id: site, amount: 50, description: 'Deposit – party', customer_name: 'Sam Jones', customer_email: 'sam@example.co.uk', send_email: true } });
  assert.equal(made.status, 201);
  const sent = calls.find((c) => c.path === '/v2/online-checkout/payment-links').body;
  assert.deepEqual(sent.quick_pay, { name: 'Deposit – party', price_money: { amount: 5000, currency: 'GBP' }, location_id: `SQ_${site}` });
  assert.equal(sent.pre_populated_data.buyer_email, 'sam@example.co.uk');
  assert.ok(sent.idempotency_key);
  const email = mailer.sent.at(-1);
  assert.equal(email.to, 'sam@example.co.uk');
  assert.match(email.text, /£50\.00 – Deposit – party/);
  assert.ok(email.text.includes(made.data.url));
  assert.ok(made.data.emailed_at);

  let list = (await admin('/payment-links')).data.links;
  assert.equal(list[0].status, 'open');
  paid = true;
  db.prepare('UPDATE payment_links SET checked_at = NULL').run();
  list = (await admin('/payment-links')).data.links;
  assert.equal(list[0].status, 'paid');
  assert.equal((await admin(`/payment-links/${list[0].id}/cancel`, { method: 'POST' })).status, 400, 'a paid link can’t be cancelled');

  paid = false;
  const other = await admin('/payment-links', { method: 'POST', body: { location_id: site, amount: 20, description: 'Cake order' } });
  const cancelled = await admin(`/payment-links/${other.data.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(other.data.square_link_id)));

  // Given the permission, a manager sees only their own sites' links.
  const set = db.prepare(`SELECT id, permissions FROM permission_sets WHERE built_in = 'manager'`).get();
  db.prepare('UPDATE permission_sets SET permissions = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(set.permissions), 'payments.send']), set.id);
  const m = await login('manager1@cafe.local');
  const theirs = (await m('/payment-links')).data.links;
  const mine = db.prepare(`SELECT location_id FROM users WHERE email = 'manager1@cafe.local'`).get().location_id;
  assert.ok(theirs.every((p) => p.location_id === mine || db.prepare('SELECT all_sites FROM users WHERE email = ?').get('manager1@cafe.local').all_sites));
});

test('the dashboard can show when data last came from Square', async () => {
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/square/freshness')).status, 403);
  const admin = await login('admin@cafe.local');
  db.prepare(`INSERT INTO square_sync_log (started_at, finished_at, status) VALUES (datetime('now'), datetime('now'), 'ok')`).run();
  const f = (await admin('/square/freshness')).data;
  assert.equal(f.connected, true);
  assert.ok(f.last_sync);
  assert.equal((await admin('/square/refresh', { method: 'POST' })).status, 404, 'no manual refresh any more');
});
