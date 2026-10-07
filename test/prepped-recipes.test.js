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
const productId = (name) => db.prepare('SELECT id FROM products WHERE name = ?').get(name).id;
const product = (name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
const perUnit = (p) => p.unit_cost / (p.units_per_pack || 1);

test('a prepped recipe has a yield; its cost per unit and allergens carry into recipes that use it', async () => {
  const a = await login('admin@cafe.local');
  // Cheese sauce: 500 g cheddar + 1000 ml milk makes 1200 g.
  const sauce = await a('/recipes', { method: 'POST', body: { kind: 'prep', name: 'Cheese sauce', yield_quantity: 1200, yield_unit: 'g',
    ingredients: [{ product_id: productId('Mature cheddar 5kg'), quantity: 500 }, { product_id: productId('Whole milk 4L'), quantity: 1000 }] } });
  assert.equal(sauce.status, 201);
  const batch = 500 * perUnit(product('Mature cheddar 5kg')) + 1000 * perUnit(product('Whole milk 4L'));
  const s = (await a(`/recipes/${sauce.data.id}`)).data;
  assert.equal(s.kind, 'prep');
  assert.equal(s.batch_cost, Math.round(batch * 100) / 100);
  assert.ok(Math.abs(s.cost_per_unit - batch / 1200) < 1e-9);
  assert.ok(s.allergens.includes('milk'));
  assert.equal(s.gp_pct, null);

  // A prepped recipe inside another prepped recipe: mac & cheese uses 600 g of sauce, makes 4 portions.
  const mac = await a('/recipes', { method: 'POST', body: { kind: 'prep', name: 'Mac & cheese base', yield_quantity: 4, yield_unit: 'portions',
    ingredients: [{ sub_recipe_id: sauce.data.id, quantity: 600 }] } });
  assert.equal(mac.status, 201);
  // A sold item using it, linked to Square.
  const dish = await a('/recipes', { method: 'POST', body: { name: 'Mac & cheese', selling_price: 9, portions: 1, square_item_name: 'Mac & cheese',
    ingredients: [{ sub_recipe_id: mac.data.id, quantity: 1 }, { product_id: productId('Sandwich bloomer'), quantity: 1 }] } });
  assert.equal(dish.status, 201);
  const d = (await a(`/recipes/${dish.data.id}`)).data;
  const macCost = (600 * batch / 1200) / 4;
  assert.equal(d.cost_per_portion, Math.round((macCost + perUnit(product('Sandwich bloomer'))) * 100) / 100);
  assert.ok(d.allergens.includes('milk'), 'allergens come through two levels of prepped recipe');
  assert.ok(d.allergens.includes('gluten'));
  assert.equal(d.ingredients[0].product_name, 'Mac & cheese base');
  assert.equal(d.ingredients[0].recipe_unit, 'portions');
  const list = (await a('/recipes')).data;
  assert.deepEqual(list.find((r) => r.id === sauce.data.id).used_in.map((u) => u.name), ['Mac & cheese base']);

  // Rules: a yield is needed; a sold item can't go into a recipe; nothing can end up inside itself.
  assert.equal((await a('/recipes', { method: 'POST', body: { kind: 'prep', name: 'No yield', ingredients: [] } })).status, 400);
  assert.equal((await a('/recipes', { method: 'POST', body: { name: 'Uses a sold item', ingredients: [{ sub_recipe_id: dish.data.id, quantity: 1 }] } })).status, 400);
  const loop = await a(`/recipes/${sauce.data.id}`, { method: 'PUT', body: { kind: 'prep', name: 'Cheese sauce', yield_quantity: 1200, yield_unit: 'g',
    ingredients: [{ sub_recipe_id: mac.data.id, quantity: 10 }] } });
  assert.equal(loop.status, 400);
  assert.match(loop.data.error, /already uses this recipe/);
  // Used in others, so it stays a prepped recipe.
  assert.equal((await a(`/recipes/${sauce.data.id}`, { method: 'PUT', body: { kind: 'sold', name: 'Cheese sauce', ingredients: [] } })).status, 400);
  // Prepped recipes don't get a Square link or price.
  await a(`/recipes/${mac.data.id}`, { method: 'PUT', body: { kind: 'prep', name: 'Mac & cheese base', yield_quantity: 4, yield_unit: 'portions', selling_price: 5, square_item_name: 'X',
    ingredients: [{ sub_recipe_id: sauce.data.id, quantity: 600 }] } });
  const m = db.prepare('SELECT selling_price, square_item_name FROM recipes WHERE id = ?').get(mac.data.id);
  assert.deepEqual({ ...m }, { selling_price: 0, square_item_name: null });
});

test('menu performance works out product usage through prepped recipes', async () => {
  const a = await login('admin@cafe.local');
  const egg = db.prepare(`SELECT id FROM recipes WHERE name = 'Egg & cress sandwich'`).get();
  const site = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id').get().id;
  const day = '2026-01-05';
  db.prepare(`INSERT INTO sales_items (location_id, date, item_key, catalog_object_id, name, variation_name, quantity, net_sales)
    VALUES (?, ?, 'egg-test', 'CAT_EGGCRESSSANDWICH', 'Egg & cress sandwich', 'Regular', 8, 33)`).run(site, day);
  const r = (await a(`/recipes/performance?from=${day}&to=${day}&location_id=${site}`)).data;
  assert.ok(r.items.some((i) => i.recipe_id === egg.id));
  // 8 sold, 4 portions a batch = 2 batches; each uses 480 g egg mayo (a whole batch), which uses 6 eggs.
  const eggs = r.usage.find((u) => u.name === 'Free-range eggs (180)');
  assert.equal(eggs.used, 12);
  // Prepped recipes aren't offered as Square items.
  assert.ok(!r.unlinked.some((u) => u.name === 'Egg mayo filling'));
});

test('prepped recipes are counted in stock takes, in their yield unit and valued at their cost per unit', async () => {
  const a = await login('admin@cafe.local');
  const site = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id DESC').get().id;
  const egg = db.prepare(`SELECT id FROM recipes WHERE name = 'Egg mayo filling'`).get().id;
  const off = await a('/recipes', { method: 'POST', body: { kind: 'prep', name: 'Not counted', yield_quantity: 1, yield_unit: 'each', in_stock_takes: false, ingredients: [] } });
  const started = await a('/stocktakes', { method: 'POST', body: { location_id: site } });
  assert.ok([200, 201].includes(started.status));
  const take = (await a(`/stocktakes/${started.data.id}`)).data;
  const line = take.lines.find((l) => l.key === `r:${egg}`);
  assert.ok(line, 'the prepped recipe is in the count');
  assert.equal(line.unit, 'g');
  assert.equal(line.category, 'Prepped recipes');
  assert.ok(!take.lines.some((l) => l.key === `r:${off.data.id}`), 'unless it isn’t counted in stock takes');
  const costPerG = (await a(`/recipes/${egg}`)).data.cost_per_unit;
  assert.ok(Math.abs(line.unit_cost - costPerG) < 1e-9);

  await a(`/stocktakes/${take.id}/lines`, { method: 'PUT', body: { lines: [{ recipe_id: egg, counted_quantity: 960 }] } });
  const after1 = (await a(`/stocktakes/${take.id}`)).data;
  assert.equal(after1.lines.find((l) => l.key === `r:${egg}`).counted_quantity, 960);
  assert.equal(after1.counted_count, 1);
  assert.equal(after1.total_value, Math.round(960 * costPerG * 100) / 100);
  const done = await a(`/stocktakes/${take.id}/complete`, { method: 'POST', body: { zero_uncounted: true } });
  assert.equal(done.status, 200);
  assert.equal(done.data.counted_count, done.data.line_count);
});
