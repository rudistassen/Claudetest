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

test('the categories products already use are on the list', async () => {
  const a = await login('admin@cafe.local');
  const cats = (await a('/product-categories')).data;
  const used = db.prepare(`SELECT DISTINCT category FROM products WHERE category IS NOT NULL`).all().map((r) => r.category);
  assert.ok(used.length);
  for (const u of used) assert.ok(cats.some((c) => c.name === u), u);
  assert.ok(cats.every((c) => typeof c.product_count === 'number'));
});

test('products must go in one of the categories (matched whatever the case)', async () => {
  const a = await login('admin@cafe.local');
  const cat = (await a('/product-categories', { method: 'POST', body: { name: 'Wrapping', xero_account_code: '325' } })).data;
  assert.equal((await a('/product-categories', { method: 'POST', body: { name: 'wrapping' } })).status, 400);
  assert.equal((await a('/products', { method: 'POST', body: { name: 'Lids' } })).status, 400, 'a category is needed');
  assert.equal((await a('/products', { method: 'POST', body: { name: 'Lids', category: 'Made up' } })).status, 400);
  const p = await a('/products', { method: 'POST', body: { name: 'Lids', category: 'WRAPPING' } });
  assert.equal(p.status, 201);
  assert.equal(p.data.category, 'Wrapping');
  // Renaming the category renames it on its products.
  await a(`/product-categories/${cat.id}`, { method: 'PUT', body: { name: 'Takeaway wrapping' } });
  assert.equal(db.prepare('SELECT category FROM products WHERE id = ?').get(p.data.id).category, 'Takeaway wrapping');
  assert.equal(db.prepare('SELECT xero_account_code FROM product_categories WHERE id = ?').get(cat.id).xero_account_code, '325', 'kept');
});

test('a category with products can only be deleted by moving them', async () => {
  const a = await login('admin@cafe.local');
  const from = (await a('/product-categories', { method: 'POST', body: { name: 'Old stuff' } })).data;
  const to = (await a('/product-categories', { method: 'POST', body: { name: 'New stuff' } })).data;
  const p = (await a('/products', { method: 'POST', body: { name: 'Thing', category: 'Old stuff' } })).data;
  assert.equal((await a(`/product-categories/${from.id}`, { method: 'DELETE' })).status, 400);
  const r = await a(`/product-categories/${from.id}`, { method: 'DELETE', body: { move_to: to.id } });
  assert.equal(r.data.moved, 1);
  assert.equal(db.prepare('SELECT category FROM products WHERE id = ?').get(p.id).category, 'New stuff');
  assert.equal((await a(`/product-categories/${to.id}`, { method: 'DELETE' })).status, 400);
});

test('staff can’t change categories', async () => {
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/product-categories', { method: 'POST', body: { name: 'Nope' } })).status, 403);
});
