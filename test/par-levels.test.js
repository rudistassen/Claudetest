import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { syncCatalog } from '../src/square.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;
let db;
let site;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  site = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id').get().id;
  // The Square catalogue: croissants and brownies are Bakery, the latte (two sizes) is Coffee.
  const objects = [
    { type: 'CATEGORY', id: 'C_BAKERY', category_data: { name: 'Bakery' } },
    { type: 'CATEGORY', id: 'C_COFFEE', category_data: { name: 'Coffee' } },
    { type: 'ITEM', id: 'I_CROISSANT', item_data: { name: 'Croissant', reporting_category: { id: 'C_BAKERY' }, variations: [{ id: 'V_CROISSANT', item_variation_data: { name: 'Regular' } }] } },
    { type: 'ITEM', id: 'I_BROWNIE', item_data: { name: 'Brownie', categories: [{ id: 'C_BAKERY' }], variations: [{ id: 'V_BROWNIE', item_variation_data: { name: 'Regular' } }] } },
    { type: 'ITEM', id: 'I_LATTE', item_data: { name: 'Latte', category_id: 'C_COFFEE', variations: [{ id: 'V_LATTE_R', item_variation_data: { name: 'Regular' } }, { id: 'V_LATTE_L', item_variation_data: { name: 'Large' } }] } },
  ];
  await syncCatalog(db, { async *listCatalog() { yield* objects; } });
  // Six full weeks of sales: croissants sell (weekday + 1) × 2 a day, brownies 3 a day; the site is shut on the
  // first Monday (no sales that day), and a latte of each size sells every day.
  db.prepare('DELETE FROM sales_items').run();
  db.prepare('DELETE FROM sales_daily').run();
  const to = addDays(weekStart(today()), -1);
  const from = addDays(to, -41);
  const item = db.prepare(`INSERT INTO sales_items (location_id, date, item_key, catalog_object_id, name, variation_name, quantity, net_sales) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  for (let d = from, i = 0; d <= to; d = addDays(d, 1), i++) {
    if (d === from) continue;
    db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, orders) VALUES (?, ?, 100, 10)').run(site, d);
    item.run(site, d, 'V_CROISSANT', 'V_CROISSANT', 'Croissant', 'Regular', ((i % 7) + 1) * 2);
    item.run(site, d, 'V_BROWNIE', 'V_BROWNIE', 'Brownie', 'Regular', 3);
    item.run(site, d, 'V_LATTE_R', 'V_LATTE_R', 'Latte', 'Regular', 1);
    item.run(site, d, 'V_LATTE_L', 'V_LATTE_L', 'Latte', 'Large', 1);
    item.run(site, d, 'adhoc:Custom', null, 'Custom amount', null, 1);
  }
  // Sales from before the six weeks don't count.
  item.run(site, addDays(from, -1), 'V_CROISSANT', 'V_CROISSANT', 'Croissant', 'Regular', 500);
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

test('par levels: average sold on each weekday over six weeks, by Square category and site', async () => {
  const a = await login('admin@cafe.local');
  const pick = (await a('/par-levels')).data;
  assert.deepEqual(pick.categories, ['Bakery', 'Coffee', 'Uncategorised']);
  assert.equal(pick.weeks, 6);

  const r = (await a(`/par-levels?category=Bakery&location_id=${site}`)).data;
  assert.deepEqual(r.days_traded, [5, 6, 6, 6, 6, 6, 6], 'the Monday it was shut is left out');
  const croissant = r.items.find((i) => i.name === 'Croissant');
  assert.deepEqual(croissant.avg, [2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual(r.items.find((i) => i.name === 'Brownie').avg, [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(r.items[0].name, 'Croissant', 'best sellers first');
  assert.ok(!r.items.some((i) => i.name === 'Latte'));
  const coffee = (await a(`/par-levels?category=Coffee&location_id=${site}`)).data;
  assert.deepEqual(coffee.items.map((i) => i.name).sort(), ['Latte – Large', 'Latte – Regular'], 'sizes shown when an item has more than one');
});

test('par levels are saved as a draft, then as a final version with only the budgeted levels', async () => {
  const a = await login('admin@cafe.local');
  const lines = [
    { item_key: 'V_CROISSANT', item_name: 'Croissant', pars: [3, 5, 7, 9, 11, 13, 15] },
    { item_key: 'V_BROWNIE', item_name: 'Brownie', pars: [null, null, null, null, null, null, null] },
  ];
  const draft = await a('/par-levels', { method: 'PUT', body: { location_id: site, category: 'Bakery', version: 'draft', lines } });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.final, null, 'no final version yet');
  let r = (await a(`/par-levels?category=Bakery&location_id=${site}`)).data;
  assert.deepEqual(r.draft.lines.find((l) => l.item_key === 'V_CROISSANT').pars, [3, 5, 7, 9, 11, 13, 15]);

  lines[1].pars = [0, 4, 4, 4, 4, 6, 0];
  assert.equal((await a('/par-levels', { method: 'PUT', body: { location_id: site, category: 'Bakery', version: 'final', lines } })).status, 200);
  r = (await a(`/par-levels?category=Bakery&location_id=${site}`)).data;
  assert.deepEqual(r.final.lines.find((l) => l.item_key === 'V_BROWNIE').pars, [null, 4, 4, 4, 4, 6, null], 'only budgeted (non-zero) levels in the final');
  assert.equal(r.final.saved_by, r.draft.saved_by);

  // Working on the draft again leaves the final version as it was.
  lines[0].pars = [1, 1, 1, 1, 1, 1, 1];
  await a('/par-levels', { method: 'PUT', body: { location_id: site, category: 'Bakery', version: 'draft', lines } });
  r = (await a(`/par-levels?category=Bakery&location_id=${site}`)).data;
  assert.deepEqual(r.final.lines.find((l) => l.item_key === 'V_CROISSANT').pars, [3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual(r.draft.lines.find((l) => l.item_key === 'V_CROISSANT').pars, [1, 1, 1, 1, 1, 1, 1]);

  const staff = await login('staff1@cafe.local');
  assert.equal((await staff(`/par-levels?category=Bakery&location_id=${site}`)).status, 403);
  assert.equal((await a('/par-levels', { method: 'PUT', body: { location_id: site, category: 'Bakery', lines: [{ item_key: 'x', item_name: 'X', pars: [-1] }] } })).status, 400);
});
