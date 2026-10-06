import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { siteFromReference } from '../src/routes/invoices.js';
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

test('each tab saves its own part and keeps the rest', async () => {
  const a = await login('admin@cafe.local');
  const s = (await a('/suppliers', { method: 'POST', body: { name: 'Tab Test Foods' } })).data;
  await a(`/suppliers/${s.id}`, { method: 'PUT', body: { contact_name: 'Jo', address: '1 Mill Lane\nLeeds', phone: '0113 000' } });
  const week = [1, 2, 3, 4, 5, 6].map((day) => ({ day, cutoff_day: day === 1 ? 7 : day - 1, cutoff_time: '22:00' }));
  const o = await a(`/suppliers/${s.id}`, { method: 'PUT', body: { order_email: 'orders@tabtest.example', cc_emails: 'rep@tabtest.example; me@cafe.example', min_order: 150, delivery_schedule: week, orders_enabled: true } });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  await a(`/suppliers/${s.id}`, { method: 'PUT', body: { payment_terms_days: 30 } });
  const got = (await a(`/suppliers/${s.id}`)).data;
  assert.equal(got.contact_name, 'Jo');
  assert.equal(got.address, '1 Mill Lane\nLeeds');
  assert.equal(got.order_email, 'orders@tabtest.example');
  assert.equal(got.cc_emails, 'rep@tabtest.example, me@cafe.example');
  assert.equal(got.min_order, 150);
  assert.deepEqual(got.delivery_schedule, week);
  assert.equal(got.payment_terms_days, 30);
  // Bad input is refused.
  assert.equal((await a(`/suppliers/${s.id}`, { method: 'PUT', body: { cc_emails: 'not an email' } })).status, 400);
  assert.equal((await a(`/suppliers/${s.id}`, { method: 'PUT', body: { delivery_schedule: [{ day: 8, cutoff_day: 1, cutoff_time: '22:00' }] } })).status, 400);
  assert.equal((await a(`/suppliers/${s.id}`, { method: 'PUT', body: { delivery_schedule: [{ day: 2, cutoff_day: 1, cutoff_time: '25:00' }] } })).status, 400);
  assert.equal((await a('/suppliers', { method: 'POST', body: { name: 'tab test foods' } })).status, 400, 'no duplicates');
  // Not for ordering: still there, just flagged.
  await a(`/suppliers/${s.id}`, { method: 'PUT', body: { orders_enabled: false } });
  assert.equal((await a('/suppliers')).data.find((x) => x.id === s.id).orders_enabled, 0);
});

test('site references put an invoice against the right site', async () => {
  const a = await login('admin@cafe.local');
  const s = (await a('/suppliers', { method: 'POST', body: { name: 'Ref Test Bakery' } })).data;
  const [one, two] = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 2').all().map((l) => l.id);
  const r = await a(`/suppliers/${s.id}/site-refs`, { method: 'PUT', body: { refs: [{ location_id: one, reference: 'HB1042' }, { location_id: two, reference: 'HB10421' }, { location_id: two, reference: '' }] } });
  assert.equal(r.data.site_refs.length, 2);
  assert.equal(siteFromReference(db, s.id, { customer_reference: 'Account no: HB1042' }), one);
  assert.equal(siteFromReference(db, s.id, { customer_reference: 'HB10421' }), two, 'the longer reference wins');
  assert.equal(siteFromReference(db, s.id, { delivered_to: 'Deliver to: Old Town café, acct HB-10421' }), null, 'only whole references count');
  assert.equal(siteFromReference(db, s.id, {}, 'Invoice for account HB1042'), one, 'from the email subject too');
  assert.equal(siteFromReference(db, null, { customer_reference: 'HB1042' }), null);
});

test('New order only offers suppliers set up for ordering, and orders go to the order email with the CCs', async () => {
  const a = await login('admin@cafe.local');
  const s = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get();
  await a(`/suppliers/${s.id}`, { method: 'PUT', body: { order_email: 'po@valley.example', cc_emails: 'boss@cafe.example' } });
  const loc = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1').get().id;
  const product = db.prepare('SELECT id FROM products WHERE supplier_id = ? LIMIT 1').get(s.id);
  const o = await a('/orders', { method: 'POST', body: { location_id: loc, supplier_id: s.id, lines: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const got = (await a(`/orders/${o.data.id}`)).data;
  assert.equal(got.supplier_email, 'po@valley.example');
  assert.equal(got.supplier_cc, 'boss@cafe.example');
});
