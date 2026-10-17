import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { mapHeaders } from '../src/product-import.js';
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

test('column headings are understood however they are written', () => {
  assert.deepEqual(mapHeaders(['Product Name', 'Supplier Code', 'Cost (£)', 'PAR', 'Notes', 'Supplier']),
    ['name', 'sku', 'unit_cost', 'par_level', null, 'supplier']);
});

test('importing products: preview first, match existing by SKU then name, blanks keep values, new suppliers added', async () => {
  const admin = await login('admin@cafe.local');
  const staff = await login('staff1@cafe.local');
  db.prepare(`UPDATE products SET sku = 'TEST-SKU-1' WHERE id = (SELECT MIN(id) FROM products WHERE supplier_id IS NOT NULL)`).run();
  const existing = db.prepare(`SELECT p.*, s.name AS supplier FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.sku = 'TEST-SKU-1'`).get();
  const byName = db.prepare('SELECT * FROM products WHERE id != ? LIMIT 1').get(existing.id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

  const headers = ['Name', 'SKU', 'Category', 'Supplier', 'Unit cost', 'Par level', 'Allergens', 'Active', 'Notes'];
  const rows = [
    ['Renamed by SKU', existing.sku, '', '', '£9.99', '', '', '', 'ignored'], // matched by SKU; blanks keep values
    [byName.name.toUpperCase(), '', '', '', '', '', '', '', ''], // matched by name, nothing to change
    ['Oat milk 1L', 'OAT-1', 'Dairy alternatives', 'Oatly Direct', '1.85', '12', 'Gluten, soya', 'yes', ''],
    ['Oat milk 1L', 'OAT-1B', '', 'Oatly Direct', '', '', '', '', ''], // the same new product twice
    ['Bad cost', '', '', '', 'cheap', '', '', '', ''],
    ['Bad allergen', '', '', '', '', '', 'Unicorn', '', ''],
    ['', '', '', '', '', '', '', '', ''], // empty row ignored
  ];
  assert.equal((await staff('/products/import', { method: 'POST', body: { headers, rows } })).status, 403);
  assert.equal((await admin('/products/import', { method: 'POST', body: { headers: ['Cost'], rows: [['1']] } })).status, 400, 'needs a Name column');

  const preview = (await admin('/products/import', { method: 'POST', body: { headers, rows } })).data;
  assert.deepEqual(preview.counts, { create: 1, update: 1, same: 1, error: 3 });
  assert.deepEqual(preview.new_suppliers, ['Oatly Direct']);
  assert.equal(preview.columns.find((c) => c.heading === 'Notes').field, null);
  const upd = preview.rows.find((r) => r.action === 'update');
  assert.equal(upd.line, 2);
  assert.ok(upd.changes.includes('name') && upd.changes.some((c) => c.startsWith('unit cost')), upd.changes.join());
  assert.match(preview.rows.find((r) => r.name === 'Bad cost').error, /isn’t a number/);
  assert.match(preview.rows.find((r) => r.name === 'Bad allergen').error, /Unknown allergen/);
  assert.match(preview.rows.find((r) => r.line === 5).error, /already on line 4/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, before, 'the preview changes nothing');

  const done = (await admin('/products/import', { method: 'POST', body: { headers, rows, apply: true } })).data;
  assert.deepEqual([done.create, done.update, done.suppliers_added], [1, 1, 1]);
  const after = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  assert.deepEqual([after.name, after.unit_cost, after.category, after.supplier_id, after.par_level], ['Renamed by SKU', 9.99, existing.category, existing.supplier_id, existing.par_level]);
  const oat = db.prepare('SELECT p.*, s.name AS supplier FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE p.sku = ?').get('OAT-1');
  assert.deepEqual([oat.name, oat.category, oat.unit, oat.unit_cost, oat.par_level, oat.allergens, oat.active, oat.supplier],
    ['Oat milk 1L', 'Dairy alternatives', 'each', 1.85, 12, 'gluten,soya', 1, 'Oatly Direct']);

  // Importing the same file again: nothing new, and switching a product off.
  const again = (await admin('/products/import', { method: 'POST', body: { headers, rows: rows.slice(0, 3) } })).data;
  assert.deepEqual([again.counts.create, again.counts.update], [0, 0]);
  await admin('/products/import', { method: 'POST', body: { headers: ['Name', 'Active'], rows: [['Oat milk 1L', 'no']], apply: true } });
  assert.equal(db.prepare('SELECT active FROM products WHERE sku = ?').get('OAT-1').active, 0);
});
