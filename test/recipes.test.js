import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

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
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
}

const productId = (name) => db.prepare('SELECT id FROM products WHERE name = ?').get(name).id;

describe('recipes', () => {
  test('costs a recipe from pack prices and works out GP after VAT', async () => {
    const admin = await login('admin@cafe.local');
    const r = await admin('/recipes', {
      method: 'POST',
      body: {
        name: 'Test toastie', category: 'Hot food', portions: 2, selling_price: 6, vat_rated: true,
        ingredients: [
          { product_id: productId('Sandwich bloomer'), quantity: 4 }, // £2.10 / 16 slices
          { product_id: productId('Mature cheddar 5kg'), quantity: 100 }, // £32 / 5000g
          { product_id: productId('Salted butter 2kg'), quantity: 20 }, // £14.50 / 2000g
        ],
      },
    });
    assert.equal(r.status, 201);
    const recipe = (await admin(`/recipes/${r.data.id}`)).data;
    const batch = 4 * (2.1 / 16) + 100 * (32 / 5000) + 20 * (14.5 / 2000);
    assert.equal(recipe.batch_cost, Math.round(batch * 100) / 100);
    assert.equal(recipe.cost_per_portion, Math.round((batch / 2) * 100) / 100);
    assert.equal(recipe.net_price, 5);
    assert.equal(recipe.gp_pct, Math.round(((5 - batch / 2) / 5) * 10000) / 100);
  });

  test('allergens come from ingredients plus any added by hand', async () => {
    const admin = await login('admin@cafe.local');
    const toastie = (await admin('/recipes')).data.find((r) => r.name === 'Ham & cheese toastie');
    assert.deepEqual(toastie.allergens, ['gluten', 'milk', 'sesame']);
    assert.deepEqual(toastie.allergen_sources.milk.sort(), ['Mature cheddar 5kg', 'Salted butter 2kg']);

    const brownie = (await admin('/recipes')).data.find((r) => r.name === 'Brownie');
    assert.deepEqual(brownie.may_contain_list, ['nuts', 'peanuts']);

    const bad = await admin('/recipes', { method: 'POST', body: { name: 'X', extra_allergens: ['chocolate'] } });
    assert.equal(bad.status, 400);
  });

  test('staff see recipes and allergens but not costs, and cannot edit', async () => {
    const staff = await login('staff1@cafe.local');
    const list = (await staff('/recipes')).data;
    assert.ok(list.length >= 14);
    assert.ok(list.every((r) => r.cost_per_portion === undefined && r.gp_pct === undefined && Array.isArray(r.allergens)));
    const one = (await staff(`/recipes/${list[0].id}`)).data;
    assert.ok(one.method);
    assert.ok(one.ingredients.every((i) => i.line_cost === undefined));
    assert.equal((await staff('/recipes', { method: 'POST', body: { name: 'X' } })).status, 403);
    const manager = await login('manager1@cafe.local');
    assert.equal((await manager('/recipes', { method: 'POST', body: { name: 'X' } })).status, 403);
  });

  test('menu performance and theoretical usage from Square sales', async () => {
    const admin = await login('admin@cafe.local');
    const loc = db.prepare(`SELECT id FROM locations WHERE name = 'High Street'`).get().id;
    const d = today();
    const ins = db.prepare('INSERT INTO sales_items (location_id, date, item_key, catalog_object_id, name, quantity, net_sales) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(loc, d, 'CAT_FLATWHITE', 'CAT_FLATWHITE', 'Flat white', 100, 300);
    ins.run(loc, d, 'adhoc:Soup of the day|', null, 'Soup of the day', 10, 45);

    const perf = (await admin(`/recipes/performance?from=${addDays(d, -1)}&to=${d}`)).data;
    const fw = perf.items.find((i) => i.name === 'Flat white');
    assert.equal(fw.quantity, 100);
    assert.equal(fw.net_sales, 300);
    assert.ok(fw.gp_pct > 60 && fw.gp_pct < 90);
    assert.equal(perf.unlinked[0].name, 'Soup of the day');
    const milk = perf.usage.find((u) => u.name === 'Whole milk 4L');
    assert.equal(milk.used, 15000); // 100 × 150ml
    assert.equal(milk.packs, 3.75);
    assert.equal(perf.usage.find((u) => u.name === 'Espresso blend 1kg').used, 1800);

    const items = (await admin('/recipes/square-items')).data;
    assert.equal(items.find((i) => i.name === 'Flat white').recipe.name, 'Flat white');
    assert.equal(items.find((i) => i.name === 'Soup of the day').recipe, null);
  });

  test('wastage of a made item is costed from its recipe', async () => {
    const staff = await login('staff2@cafe.local');
    const toastie = (await staff('/recipes')).data.find((r) => r.name === 'Ham & cheese toastie');
    const w = await staff('/wastage', { method: 'POST', body: { recipe_id: toastie.id, quantity: 2, reason: 'Over-production' } });
    assert.equal(w.status, 201);
    assert.equal(w.data.item_name, 'Ham & cheese toastie');
    assert.equal(w.data.unit, 'portion');
    const admin = await login('admin@cafe.local');
    const cost = (await admin(`/recipes/${toastie.id}`)).data.cost_per_portion;
    assert.equal(w.data.total_cost, Math.round(cost * 2 * 100) / 100);
  });
});
