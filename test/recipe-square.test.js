import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { syncCatalog } from '../src/square.js';

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

test('Square items come with their SKU, price and category, and a sold item keeps its SKU', async () => {
  await syncCatalog(db, { async *listCatalog() {
    yield { type: 'CATEGORY', id: 'C_HOT', category_data: { name: 'Hot food' } };
    yield { type: 'ITEM', id: 'I_TOASTIE', item_data: { name: 'Cheese toastie', reporting_category: { id: 'C_HOT' }, variations: [
      { id: 'V_TOASTIE', item_variation_data: { name: 'Regular', sku: 'HF-001', pricing_type: 'FIXED_PRICING', price_money: { amount: 675, currency: 'GBP' } } }] } };
    yield { type: 'ITEM', id: 'I_SPECIAL', item_data: { name: 'Daily special', variations: [{ id: 'V_SPECIAL', item_variation_data: { name: 'Regular', pricing_type: 'VARIABLE_PRICING' } }] } };
  } });
  const a = await login('admin@cafe.local');
  const items = (await a('/recipes/square-items')).data;
  const toastie = items.find((i) => i.catalog_object_id === 'V_TOASTIE');
  assert.deepEqual([toastie.name, toastie.sku, toastie.price, toastie.category, toastie.quantity], ['Cheese toastie', 'HF-001', 6.75, 'Hot food', 0], 'in Square even if not sold yet');
  assert.equal(items.find((i) => i.catalog_object_id === 'V_SPECIAL').price, null, 'a price set at the till has none');

  const made = await a('/recipes', { method: 'POST', body: { kind: 'sold', name: 'Cheese toastie', sku: 'HF-001', category: 'Hot food', selling_price: 6.75, square_catalog_object_id: 'V_TOASTIE', square_item_name: 'Cheese toastie', ingredients: [] } });
  assert.equal(made.status, 201);
  assert.equal((await a(`/recipes/${made.data.id}`)).data.sku, 'HF-001');
  assert.equal((await a('/recipes/square-items')).data.find((i) => i.catalog_object_id === 'V_TOASTIE').recipe.id, made.data.id);
});
