import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { memoryMailbox } from '../src/mailbox.js';
import { checkOrderReplies } from '../src/order-inbox.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
const box = memoryMailbox([], 'orders@brewandbarrel.co.uk');
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { orders: box }).listen(0);
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

async function draftOrder(m, site) {
  const supplier = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id;
  db.prepare(`UPDATE suppliers SET order_email = 'orders@valleydairy.example', cc_emails = 'rep@valleydairy.example' WHERE id = ?`).run(supplier);
  db.prepare(`INSERT OR REPLACE INTO supplier_site_refs (supplier_id, location_id, reference) VALUES (?, ?, 'ACC-42')`).run(supplier, site);
  const product = db.prepare('SELECT id FROM products WHERE supplier_id = ? ORDER BY id LIMIT 1').get(supplier).id;
  const r = await m('/orders', { method: 'POST', body: { location_id: site, supplier_id: supplier, delivery_date: '2026-10-20', notes: 'Back door please', lines: [{ product_id: product, quantity: 3 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

test('orders are emailed from the orders mailbox, replies are matched to them, and can be answered', async () => {
  const manager = await login('manager1@cafe.local');
  const site = db.prepare(`SELECT location_id FROM users WHERE email = 'manager1@cafe.local'`).get().location_id;
  const id = await draftOrder(manager, site);

  const before = (await manager(`/orders/${id}/emails`)).data;
  assert.equal(before.connected, true);
  assert.equal(before.address, 'orders@brewandbarrel.co.uk');
  assert.deepEqual(before.to, ['orders@valleydairy.example']);
  assert.deepEqual(before.cc, ['rep@valleydairy.example']);
  assert.match(before.preview.subject, new RegExp(`^Order PO-${id} – `));
  assert.match(before.preview.text, /- 3 x /);
  assert.match(before.preview.text, /Account number: ACC-42/);
  assert.match(before.preview.text, /Back door please/);

  const sent = await manager(`/orders/${id}/email`, { method: 'POST', body: { message: 'Before 10am please' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const email = box.sent.at(-1);
  assert.deepEqual(email.to, ['orders@valleydairy.example']);
  assert.deepEqual(email.cc, ['rep@valleydairy.example']);
  assert.match(email.html, /Before 10am please/);
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  assert.equal(order.status, 'sent');
  assert.equal(order.email_conversation_id, email.conversationId);

  // A reply in the thread, one naming PO-<id> in a new email, an unrelated email and one from the mailbox itself.
  db.prepare(`UPDATE order_messages SET created_at = datetime('now', '-1 hour') WHERE order_id = ?`).run(id);
  const at = (s) => new Date(Date.now() - (60 - s) * 1000).toISOString();
  box.messages.push(
    { id: 'r1', subject: `RE: Order PO-${id}`, from: 'orders@valleydairy.example', fromName: 'Valley Dairy', receivedAt: at(1), conversationId: email.conversationId, body: 'Confirmed for Tuesday.\n\nOn Mon, someone wrote:\n> the order', hasAttachments: false },
    { id: 'r2', subject: `Delivery update for PO-${id}`, from: 'driver@valleydairy.example', receivedAt: at(2), conversationId: 'other', body: 'Running 30 minutes late.', hasAttachments: true, webLink: 'https://outlook.office.com/x' },
    { id: 'r3', subject: 'Our new price list', from: 'sales@valleydairy.example', receivedAt: at(3), conversationId: 'another', body: 'Prices attached' },
    { id: 'r4', subject: `RE: Order PO-${id}`, from: 'orders@brewandbarrel.co.uk', receivedAt: at(4), conversationId: email.conversationId, body: 'Our own' },
  );
  const summary = await checkOrderReplies(db, { mailbox: box });
  assert.equal(summary.added, 2, JSON.stringify(summary));
  assert.equal((await checkOrderReplies(db, { mailbox: box })).added, 0, 'each email is only added once');
  assert.equal(db.prepare('SELECT reply_unread FROM purchase_orders WHERE id = ?').get(id).reply_unread, 1);
  assert.ok((await manager(`/orders?location_id=${site}`)).data.find((o) => o.id === id).reply_unread);
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE kind = 'order_reply'`).get(), 'people are told');

  const thread = (await manager(`/orders/${id}/emails`)).data.messages;
  assert.deepEqual(thread.map((m) => m.direction), ['out', 'in', 'in']);
  assert.equal(thread[1].body, 'Confirmed for Tuesday.', 'the quoted order is left off');
  assert.equal(thread[2].has_attachments, 1);
  assert.equal(db.prepare('SELECT reply_unread FROM purchase_orders WHERE id = ?').get(id).reply_unread, 0, 'looking marks it read');

  const reply = await manager(`/orders/${id}/reply`, { method: 'POST', body: { text: 'Thanks – see you Tuesday.' } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(box.sent.at(-1).reply_to, 'r2', 'answers the latest email from the supplier');
  assert.equal((await manager(`/orders/${id}/emails`)).data.messages.at(-1).direction, 'out');

  // Staff can't.
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/orders/${id}/emails`)).status, 403);
});

test('without the orders mailbox, orders can’t be emailed from Atlas', async () => {
  const d = openDb(':memory:');
  seedAdmin(d, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(d);
  const s = createApp(d).listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const url = `http://127.0.0.1:${s.address().port}/api`;
    const res = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: DEMO_PASSWORD }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const o = { id: Number(d.prepare(`INSERT INTO purchase_orders (location_id, supplier_id) VALUES ((SELECT MIN(id) FROM locations), (SELECT MIN(id) FROM suppliers))`).run().lastInsertRowid) };
    const status = await (await fetch(`${url}/orders/${o.id}/emails`, { headers: { cookie } })).json();
    assert.equal(status.connected, false);
    const r = await fetch(`${url}/orders/${o.id}/email`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
  } finally { s.close(); }
});
