import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../src/db.js';
import { claudeInvoiceReader, INVOICE_SCHEMA, invoiceReaderFromEnv } from '../src/invoice-reader.js';
import { matchLine, matchSupplier } from '../src/routes/invoices.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
let nextRead;
const reader = { model: 'test', async read(file) { reader.last = file; return structuredClone(nextRead); } };

before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { invoiceReader: reader }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

const PDF = Buffer.from('%PDF-1.4 pretend invoice').toString('base64');

test('recognising suppliers and products from what an invoice says', () => {
  const dairy = db.prepare(`SELECT * FROM suppliers WHERE name = 'Valley Dairy'`).get();
  assert.equal(matchSupplier(db, { name: 'VALLEY DAIRY LIMITED' }).supplier_id, dairy.id);
  assert.equal(matchSupplier(db, { name: 'The Valley Dairy Co.' }).supplier_id, dairy.id);
  assert.equal(matchSupplier(db, { name: 'Somebody Else Ltd' }).supplier_id, null);
  if (dairy.email) assert.equal(matchSupplier(db, { name: 'VD Trading', email: `accounts@${dairy.email.split('@')[1]}` }).supplier_id, dairy.id);
  const milk = db.prepare(`SELECT * FROM products WHERE supplier_id = ? ORDER BY id LIMIT 1`).get(dairy.id);
  assert.deepEqual(matchLine(db, dairy.id, { description: milk.name.toUpperCase() }), { product_id: milk.id, match: 'name' });
  db.prepare('UPDATE products SET sku = ? WHERE id = ?').run('VD-001', milk.id);
  assert.deepEqual(matchLine(db, dairy.id, { description: 'Something printed differently', sku: 'vd 001' }), { product_id: milk.id, match: 'sku' });
  assert.equal(matchLine(db, dairy.id, { description: 'Completely unrelated widget' }).product_id, null);
});

test('invoices: upload, check, confirm – adding the supplier and products, updating costs and learning matches', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = manager.me.location_id;
  const dairy = db.prepare(`SELECT * FROM suppliers WHERE name = 'Valley Dairy'`).get();
  const [a, b] = db.prepare('SELECT * FROM products WHERE supplier_id = ? AND active = 1 ORDER BY id LIMIT 2').all(dairy.id);
  const scan = (body = {}) => manager('/invoices/scan', { method: 'POST', body: { location_id: site, file_name: 'inv.pdf', media_type: 'application/pdf', data: PDF, ...body } });

  assert.equal((await staff('/invoices')).status, 403);
  assert.equal((await scan({ media_type: 'image/heic' })).status, 400, 'only PDFs and common photos');
  nextRead = { is_invoice: false, supplier: {}, lines: [] };
  assert.equal((await scan()).status, 400, 'not an invoice');

  nextRead = {
    is_invoice: true,
    supplier: { name: 'Valley Dairy Ltd', email: null },
    invoice_number: 'VD-1001', invoice_date: '2026-09-26', due_date: null, order_reference: 'PO-12', currency: 'GBP',
    lines: [
      { description: a.name, sku: null, quantity: 4, unit: a.unit, unit_price: Math.round(a.unit_cost * 1.1 * 100) / 100, line_total: 10, vat_rate: 0 },
      { description: `${b.name} (special pack)`, sku: null, quantity: 1, unit: null, unit_price: b.unit_cost * 3, line_total: 5, vat_rate: 0 },
      { description: 'Mystery syrup 750ml', sku: 'MS-750', quantity: 2, unit: 'bottle', unit_price: 6.5, line_total: 13, vat_rate: 20 },
    ],
    subtotal: 30, vat: 2.6, total: 32.6, notes: null,
  };
  const up = await scan();
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual(reader.last, { media_type: 'application/pdf', data: PDF });
  const inv = up.data;
  assert.equal(inv.supplier_id, dairy.id);
  assert.equal(inv.status, 'review');
  assert.match(inv.notes, /PO-12/);
  assert.equal(inv.lines[0].product_id, a.id);
  assert.equal(inv.lines[0].update_cost, 1, 'a 10% price change is offered as a cost update');
  assert.equal(inv.lines[2].product_id, null);
  assert.ok(inv.warnings.some((w) => /add up to £28.00/.test(w.text)), 'lines vs subtotal');

  // The original file comes back as uploaded.
  const file = await manager(`/invoices/${inv.id}/file`);
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.data.toString(), '%PDF-1.4 pretend invoice');
  assert.equal((await manager('/invoices')).data.to_check, 1);

  // Check it: match line 2 by hand, add line 3 as a new product, confirm.
  const body = {
    supplier_id: dairy.id, invoice_number: 'VD-1001', invoice_date: '2026-09-26', subtotal: 28, vat: 2.6, total: 30.6,
    lines: inv.lines.map((l, i) => ({ id: l.id, description: l.description, sku: l.sku, unit: l.unit, quantity: l.quantity, unit_price: l.unit_price, line_total: l.line_total,
      product: i === 0 ? a.id : i === 1 ? b.id : 'new', update_cost: i === 0 })),
  };
  const done = await manager(`/invoices/${inv.id}/confirm`, { method: 'POST', body });
  assert.equal(done.status, 403, 'managers without the products permission can’t add products');
  const admin = await login('admin@cafe.local');
  const ok = await admin(`/invoices/${inv.id}/confirm`, { method: 'POST', body });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.costs_updated, ok.data.products_added, ok.data.supplier_added, ok.data.learnt], [1, 1, false, 1]);
  assert.equal(db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(a.id).unit_cost, inv.lines[0].unit_price);
  assert.equal(db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(b.id).unit_cost, b.unit_cost, 'not ticked, not changed');
  const syrup = db.prepare(`SELECT * FROM products WHERE sku = 'MS-750'`).get();
  assert.deepEqual([syrup.name, syrup.supplier_id, syrup.unit_cost, syrup.unit], ['Mystery syrup 750ml', dairy.id, 6.5, 'bottle']);
  assert.equal((await admin(`/invoices/${inv.id}`, { method: 'PUT', body })).status, 400, 'confirmed invoices are locked');

  // The same supplier again: the hand match is remembered, the new product is known, and it's flagged as a duplicate.
  const again = await scan();
  assert.equal(again.data.lines[1].product_id, b.id);
  assert.equal(again.data.lines[1].match, 'learnt');
  assert.equal(again.data.lines[2].product_id, syrup.id);
  assert.ok(again.data.warnings.some((w) => w.type === 'duplicate'));

  // A supplier nobody has set up: added when the invoice is confirmed.
  nextRead = { ...nextRead, supplier: { name: 'Fresh Fields Produce', email: 'sales@freshfields.test', phone: '0123' }, invoice_number: 'FF-1', lines: [nextRead.lines[0]] };
  const fresh = (await scan()).data;
  assert.equal(fresh.supplier_id, null);
  assert.equal((await admin(`/invoices/${fresh.id}/confirm`, { method: 'POST', body: { lines: [] } })).status, 400, 'needs a supplier');
  const added = await admin(`/invoices/${fresh.id}/confirm`, { method: 'POST', body: { new_supplier: true, lines: [{ description: 'Leeks', product: null }] } });
  assert.equal(added.data.supplier_added, true);
  assert.deepEqual({ ...db.prepare(`SELECT email, phone FROM suppliers WHERE name = 'Fresh Fields Produce'`).get() }, { email: 'sales@freshfields.test', phone: '0123' });

  // Other sites' invoices aren't visible; deleting.
  const other = await login('manager2@cafe.local');
  assert.equal((await other(`/invoices/${again.data.id}`)).status, 403);
  assert.equal((await manager(`/invoices/${again.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await manager(`/invoices/${inv.id}`, { method: 'DELETE' })).status, 403, 'only admins delete confirmed invoices');
});

test('without an API key invoice reading is off', async () => {
  assert.equal(invoiceReaderFromEnv({}), null);
  const app = createApp(db).listen(0);
  await new Promise((r) => app.once('listening', r));
  try {
    const url = `http://127.0.0.1:${app.address().port}/api`;
    const res = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: DEMO_PASSWORD }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const list = await (await fetch(`${url}/invoices`, { headers: { cookie } })).json();
    assert.equal(list.ready, false);
    const r = await fetch(`${url}/invoices/scan`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_type: 'application/pdf', data: PDF }) });
    assert.equal(r.status, 400);
  } finally {
    app.close();
  }
});

test('the Claude reader sends the PDF with a fixed output shape and handles refusals', async () => {
  const calls = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ is_invoice: true, lines: [] }) }] };
  const client = { beta: { messages: { create: async (params) => { calls.push(params); return reply; } } } };
  const r = claudeInvoiceReader({ client });
  assert.deepEqual(await r.read({ media_type: 'application/pdf', data: PDF }), { is_invoice: true, lines: [] });
  const p = calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual([p.betas, p.fallbacks], [['server-side-fallback-2026-07-01'], 'default']);
  assert.deepEqual(p.output_config.format, { type: 'json_schema', schema: INVOICE_SCHEMA });
  assert.deepEqual(p.messages[0].content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } });
  await r.read({ media_type: 'image/jpeg', data: 'abc' });
  assert.equal(calls[1].messages[0].content[0].type, 'image');

  reply = { stop_reason: 'refusal', content: [] };
  await assert.rejects(r.read({ media_type: 'application/pdf', data: PDF }), (e) => e.status === 422);
  reply = { stop_reason: 'max_tokens', content: [] };
  await assert.rejects(r.read({ media_type: 'application/pdf', data: PDF }), /too long/);
  const failing = claudeInvoiceReader({ client: { beta: { messages: { create: async () => { throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers()); } } } } });
  await assert.rejects(failing.read({ media_type: 'application/pdf', data: PDF }), /ANTHROPIC_API_KEY/);
  const noWorkspace = claudeInvoiceReader({ client: { beta: { messages: { create: async () => { throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.' } }, undefined, new Headers()); } } } } });
  await assert.rejects(noWorkspace.read({ media_type: 'application/pdf', data: PDF }), /Workspaces → your workspace → API keys/);
  // ANTHROPIC_WORKSPACE_ID is sent as the workspace header.
  const withWs = invoiceReaderFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_WORKSPACE_ID: 'wrkspc_123' });
  assert.ok(withWs);

  // Every object in the schema is closed, as structured outputs require.
  const walk = (s) => {
    if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort()); Object.values(s.properties).forEach(walk); }
    if (s.items) walk(s.items);
    (s.anyOf ?? []).forEach(walk);
  };
  walk(INVOICE_SCHEMA);
  // The API rejects schemas with more than 16 optional (union-typed) fields.
  let unions = 0;
  const count = (x) => { if (x.anyOf || Array.isArray(x.type)) unions++; Object.values(x.properties ?? {}).forEach(count); if (x.items) count(x.items); };
  count(INVOICE_SCHEMA);
  assert.ok(unions <= 16, `${unions} optional fields`);

  // Empty text from the model means "not on the invoice".
  reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ is_invoice: true, invoice_number: '', supplier: { name: 'Acme', email: ' ' }, lines: [{ description: 'Milk', sku: '', quantity: 2 }] }) }] };
  assert.deepEqual(await r.read({ media_type: 'application/pdf', data: PDF }),
    { is_invoice: true, invoice_number: null, supplier: { name: 'Acme', email: null }, lines: [{ description: 'Milk', sku: null, quantity: 2 }] });
});
