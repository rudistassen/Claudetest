import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

// A pretend Xero, recording what Atlas sends.
const calls = [];
let refreshOk = true;
let tokenN = 0;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeXero(url, init = {}) {
  const u = new URL(url);
  const body = init.body;
  calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, headers: init.headers ?? {}, body });
  if (u.pathname === '/connect/token') {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'refresh_token' && !refreshOk) return json(400, { error: 'invalid_grant' });
    tokenN++;
    return json(200, { access_token: `AT${tokenN}`, refresh_token: `RT${tokenN}`, expires_in: 1800 });
  }
  if (u.pathname === '/connections') return json(200, [{ tenantId: 'T1', tenantName: 'Brew & Barrel Ltd', tenantType: 'ORGANISATION' }]);
  if (u.pathname === '/api.xro/2.0/Accounts') return json(200, { Accounts: [{ Code: '310', Name: 'Cost of goods sold', Type: 'DIRECTCOSTS', Status: 'ACTIVE' }, { Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' }] });
  if (u.pathname === '/api.xro/2.0/TrackingCategories') return json(200, { TrackingCategories: [{ TrackingCategoryID: 'TC1', Name: 'Site', Status: 'ACTIVE', Options: [{ Name: 'Harbour', Status: 'ACTIVE' }, { Name: 'High St', Status: 'ACTIVE' }] }] });
  if (u.pathname === '/api.xro/2.0/Contacts' && (init.method ?? 'GET') === 'GET') return json(200, { Contacts: [] });
  if (u.pathname === '/api.xro/2.0/Contacts') return json(200, { Contacts: [{ ContactID: 'C1', Name: JSON.parse(body).Contacts[0].Name }] });
  if (u.pathname === '/api.xro/2.0/Invoices') return json(200, { Invoices: [{ InvoiceID: 'INV1', Status: 'DRAFT' }] });
  if (u.pathname.startsWith('/api.xro/2.0/Invoices/INV1/Attachments/')) return json(200, { Attachments: [{ AttachmentID: 'A1' }] });
  return json(404, { Message: 'Not found' });
}

let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const config = { clientId: 'CID', clientSecret: 'SECRET', redirectUri: 'https://brewly.test/api/xero/callback', scopes: 'offline_access accounting.invoices' };
  server = createApp(db, { xero: { config, fetch: fakeXero } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, location: r.headers.get('location'), data: await r.json().catch(() => null) };
  };
  return call;
}

test('Xero: connect, choose coding, and send a confirmed invoice as a draft bill (once)', async () => {
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/xero')).status, 403, 'admins only');
  const admin = await login('admin@cafe.local');
  assert.deepEqual([(await admin('/xero')).data.configured, (await admin('/xero')).data.connected], [true, false]);

  // Off to Xero's sign-in, and back with a code.
  const go = await admin('/xero/connect');
  assert.equal(go.status, 302);
  const auth = new URL(go.location);
  assert.equal(auth.origin + auth.pathname, 'https://login.xero.com/identity/connect/authorize');
  assert.equal(auth.searchParams.get('client_id'), 'CID');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://brewly.test/api/xero/callback');
  const state = auth.searchParams.get('state');
  assert.match((await admin('/xero/callback?code=X&state=wrong')).location, /error=/, 'an unknown sign-in is refused');
  const back = await admin(`/xero/callback?code=CODE1&state=${state}`);
  assert.equal(back.location, '/#/admin/xero?connected=1');
  const tokenCall = calls.find((c) => c.path === '/connect/token');
  assert.equal(new URLSearchParams(tokenCall.body).get('code'), 'CODE1');
  assert.equal(tokenCall.headers.Authorization, `Basic ${Buffer.from('CID:SECRET').toString('base64')}`);
  const status = (await admin('/xero')).data;
  assert.equal(status.connected, true);
  assert.equal(status.tenant_name, 'Brew & Barrel Ltd');
  assert.ok(!JSON.stringify(status).includes('RT1'), 'tokens never go to the browser');

  const opts = (await admin('/xero/options')).data;
  assert.deepEqual(opts.accounts, [{ code: '310', name: 'Cost of goods sold' }]);
  assert.deepEqual(opts.tracking[0].options, ['Harbour', 'High St']);
  const site = db.prepare(`SELECT id, name FROM locations WHERE name = 'High Street'`).get();
  await admin('/xero/settings', { method: 'PUT', body: { account_code: '310', tracking_category_id: 'TC1', tracking_category_name: 'Site', site_options: { [site.id]: 'High St' } } });

  // A confirmed invoice from a new-to-Xero supplier, with a 20% VAT line and a zero-rated one.
  const supplier = db.prepare('SELECT id, name FROM suppliers LIMIT 1').get();
  const invId = Number(db.prepare(`INSERT INTO invoices (location_id, supplier_id, supplier_name, invoice_number, invoice_date, due_date, subtotal, vat, total, status, file_name, file_type, file)
    VALUES (?, ?, ?, 'INV-77', '2026-10-01', '2026-10-31', 30, 2, 32, 'confirmed', 'inv 77.pdf', 'application/pdf', ?)`).run(site.id, supplier.id, supplier.name, Buffer.from('%PDF-1.4 x')).lastInsertRowid);
  // Oat milk is a product in the Dairy category, which has its own account; Cups isn't matched to a product.
  db.prepare(`INSERT INTO product_categories (name, xero_account_code) VALUES ('Dairy test', '320')`).run();
  // Its VAT code (exempt, say) is used rather than the 0% read off the invoice.
  const oat = Number(db.prepare(`INSERT INTO products (name, category, vat_code) VALUES ('Oat milk test', 'Dairy test', 'EXEMPTINPUT')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO invoice_lines (invoice_id, line_no, description, sku, quantity, unit_price, line_total, vat_rate, product_id) VALUES (?, 1, 'Oat milk', 'OM1', 6, 1.5, 9, 0, ?), (?, 2, 'Cups', NULL, 1, 21, 21, 20, NULL)`).run(invId, oat, invId);
  assert.equal((await admin(`/invoices/${invId}`)).data.xero_ready, true);

  const sent = await admin(`/invoices/${invId}/xero`, { method: 'POST' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.url, 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=INV1');
  const bill = JSON.parse(calls.find((c) => c.path === '/api.xro/2.0/Invoices').body).Invoices[0];
  assert.equal(bill.Type, 'ACCPAY');
  assert.equal(bill.Status, 'DRAFT');
  assert.equal(bill.InvoiceNumber, 'INV-77');
  assert.equal(bill.Contact.ContactID, 'C1');
  assert.deepEqual(bill.LineItems.map((l) => [l.Description, l.Quantity, l.UnitAmount, l.AccountCode, l.TaxType, l.Tracking[0].Option]),
    [['Oat milk (OM1)', 6, 1.5, '320', 'EXEMPTINPUT', 'High St'], ['Cups', 1, 21, '310', 'INPUT2', 'High St']]);
  const attach = calls.find((c) => c.path.startsWith('/api.xro/2.0/Invoices/INV1/Attachments/'));
  assert.equal(attach.headers['Content-Type'], 'application/pdf');
  assert.ok(calls.every((c) => !c.path.startsWith('/api.xro') || c.headers['xero-tenant-id'] === 'T1'));
  assert.equal(db.prepare('SELECT xero_contact_id FROM suppliers WHERE id = ?').get(supplier.id).xero_contact_id, 'C1', 'remembered');
  assert.equal((await admin(`/invoices/${invId}/xero`, { method: 'POST' })).status, 400, 'never twice');
  assert.equal((await admin(`/invoices/${invId}`)).data.xero_url, sent.data.url);

  // No due date on the invoice: the supplier's payment terms set it.
  db.prepare('UPDATE suppliers SET payment_terms_days = 14 WHERE id = ?').run(supplier.id);
  const inv2 = Number(db.prepare(`INSERT INTO invoices (location_id, supplier_id, supplier_name, invoice_number, invoice_date, subtotal, vat, total, status)
    VALUES (?, ?, ?, 'INV-78', '2026-10-01', 10, 0, 10, 'confirmed')`).run(site.id, supplier.id, supplier.name).lastInsertRowid);
  const before = calls.length;
  assert.equal((await admin(`/invoices/${inv2}/xero`, { method: 'POST' })).status, 200);
  const bill2 = JSON.parse(calls.slice(before).find((c) => c.path === '/api.xro/2.0/Invoices').body).Invoices[0];
  assert.equal(bill2.DueDate, '2026-10-15');

  // Tokens are refreshed when they run out; an expired connection asks for a reconnect.
  db.prepare('UPDATE xero_connection SET expires_at = 0').run();
  await admin('/xero/options');
  assert.ok(calls.some((c) => c.path === '/connect/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token'));
  assert.equal(db.prepare('SELECT refresh_token FROM xero_connection').get().refresh_token, 'RT2', 'the new refresh token is kept');
  refreshOk = false;
  db.prepare('UPDATE xero_connection SET expires_at = 0').run();
  const expired = await admin('/xero/options');
  assert.equal(expired.status, 400);
  assert.match(expired.data.error, /expired/);
  assert.equal((await admin('/xero')).data.connected, false);
});
