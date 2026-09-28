import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient, summariseOrder, syncSales } from '../src/square.js';
import { addDays, today } from '../src/util.js';

const TOKEN = 'test-token';
const SQ_LOCATIONS = [
  { id: 'SQ_HIGH', name: 'High Street', status: 'ACTIVE', timezone: 'Europe/London', currency: 'GBP', address: { address_line_1: '11 High Street', locality: 'Townsville', postal_code: 'AB1 2CD' } },
  { id: 'SQ_NEW', name: 'Airport Kiosk', status: 'ACTIVE', timezone: 'Europe/London', currency: 'GBP' },
];

const money = (pence) => ({ amount: pence, currency: 'GBP' });
// A UK sale: VAT-inclusive prices, so total_tax_money is part of total_money.
const line = (name, qty, totalPence, taxPence, extra = {}) => ({
  uid: name, name, quantity: String(qty), catalog_object_id: `CAT_${name.replace(/\W/g, '')}`,
  total_money: money(totalPence), total_tax_money: money(taxPence), total_discount_money: money(0), ...extra,
});

let orders = [];
const requests = [];

// Minimal stand-in for Square's Locations and Orders APIs, paging 2 orders at a time.
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] });
    if (req.method === 'GET' && req.url === '/v2/locations') return send(200, { locations: SQ_LOCATIONS });
    if (req.method === 'POST' && req.url === '/v2/orders/search') {
      const q = JSON.parse(body);
      const { start_at: start, end_at: end } = q.query.filter.date_time_filter.closed_at;
      const matching = orders.filter((o) => q.location_ids.includes(o.location_id) && o.closed_at >= start && o.closed_at < end);
      const offset = Number(q.cursor ?? 0);
      const page = matching.slice(offset, offset + 2);
      return send(200, { orders: page, ...(offset + 2 < matching.length ? { cursor: String(offset + 2) } : {}) });
    }
    send(404, { errors: [{ code: 'NOT_FOUND', detail: 'Not found' }] });
  });
});

let server;
let base;
let db;
let square;

before(async () => {
  await new Promise((r) => mock.listen(0, r));
  const config = { token: TOKEN, environment: 'sandbox', baseUrl: `http://127.0.0.1:${mock.address().port}`, version: '2025-01-23', syncMinutes: 30 };
  square = { config, client: new SquareClient(config) };
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { square }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  mock.close();
});

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

describe('order summaries', () => {
  test('net sales exclude VAT and tips, and returns are subtracted', () => {
    const s = summariseOrder({
      closed_at: '2026-07-01T23:30:00Z', // 00:30 BST on 2 July
      total_tip_money: money(100),
      line_items: [line('Flat white', 2, 700, 117), line('Croissant', 1, 300, 0)],
      returns: [{ return_line_items: [line('Croissant', 1, 300, 0)] }],
    }, 'Europe/London');
    assert.equal(s.date, '2026-07-02');
    assert.equal(s.tips, 1);
    const net = s.lines.reduce((t, l) => t + l.net, 0);
    assert.equal(Math.round(net * 100), 700 - 117);
  });
});

describe('Square integration', () => {
  test('lists Square locations and links or imports them', async () => {
    const admin = await login('admin@cafe.local');
    const list = (await admin('/square/locations')).data;
    assert.equal(list.length, 2);
    assert.equal(list[0].linked_location, null);

    const high = (await admin('/locations')).data.find((l) => l.name === 'High Street');
    const link = await admin(`/locations/${high.id}/square`, { method: 'PUT', body: { square_location_id: 'SQ_HIGH' } });
    assert.equal(link.data.square_location_id, 'SQ_HIGH');
    const other = (await admin('/locations')).data.find((l) => l.name === 'Harbour');
    assert.equal((await admin(`/locations/${other.id}/square`, { method: 'PUT', body: { square_location_id: 'SQ_HIGH' } })).status, 400);

    const imported = await admin('/square/import-location', { method: 'POST', body: { square_location_id: 'SQ_NEW' } });
    assert.equal(imported.status, 201);
    assert.equal(imported.data.name, 'Airport Kiosk');
    const relisted = (await admin('/square/locations')).data;
    assert.equal(relisted.find((l) => l.id === 'SQ_HIGH').linked_location.name, 'High Street');
  });

  test('syncs completed orders into daily sales, idempotently', async () => {
    const d = today();
    const y = addDays(d, -1);
    orders = [
      { id: 'o1', location_id: 'SQ_HIGH', state: 'COMPLETED', closed_at: `${y}T09:00:00Z`, line_items: [line('Flat white', 2, 700, 117)] },
      { id: 'o2', location_id: 'SQ_HIGH', state: 'COMPLETED', closed_at: `${y}T12:00:00Z`, line_items: [line('Toastie', 1, 650, 108), line('Flat white', 1, 350, 58)] },
      { id: 'o3', location_id: 'SQ_HIGH', state: 'COMPLETED', closed_at: `${d}T08:00:00Z`, line_items: [line('Croissant', 3, 900, 0)] },
      { id: 'o4', location_id: 'SQ_OTHER', state: 'COMPLETED', closed_at: `${d}T08:00:00Z`, line_items: [line('Ignored', 1, 1000, 0)] },
    ];
    requests.length = 0;
    const r = await syncSales(db, square.client, { from: y, to: d });
    assert.equal(r.orders, 3);

    const search = requests.filter((q) => q.url === '/v2/orders/search');
    assert.equal(search.length, 2, 'follows the pagination cursor');
    assert.equal(search[0].headers['square-version'], '2025-01-23');
    assert.deepEqual(search[0].body.location_ids.sort(), ['SQ_HIGH', 'SQ_NEW']);
    assert.deepEqual(search[0].body.query.filter.state_filter.states, ['COMPLETED']);
    assert.equal(search[0].body.query.sort.sort_field, 'CLOSED_AT');

    const highId = db.prepare(`SELECT id FROM locations WHERE square_location_id = 'SQ_HIGH'`).get().id;
    const rows = db.prepare('SELECT * FROM sales_daily WHERE location_id = ? ORDER BY date').all(highId);
    assert.deepEqual(rows.map((x) => [x.date, x.net_sales, x.orders]), [[y, 14.17, 2], [d, 9, 1]]);
    const flatWhite = db.prepare(`SELECT SUM(quantity) AS q FROM sales_items WHERE name = 'Flat white'`).get().q;
    assert.equal(flatWhite, 3);

    await syncSales(db, square.client, { from: y, to: d });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_daily').get().n, 2, 're-syncing replaces rather than duplicates');
  });

  test('sales report shows labour and wastage as % of sales', async () => {
    const manager = await login('manager1@cafe.local');
    const me = (await manager('/auth/me')).data.user;
    const highId = db.prepare(`SELECT id FROM locations WHERE square_location_id = 'SQ_HIGH'`).get().id;
    assert.equal(me.location_id, highId, 'manager1 runs High Street');

    await manager('/wastage', { method: 'POST', body: { item_name: 'Milk', quantity: 1, unit_cost: 2.62, reason: 'Out of date' } });
    const report = (await manager(`/sales?from=${addDays(today(), -1)}&to=${today()}`)).data;
    assert.equal(report.totals.net_sales, 23.17);
    assert.equal(report.totals.orders, 3);
    assert.equal(report.totals.wastage_pct, 11.31);
    assert.ok(report.totals.labour_cost > 0);
    assert.ok(Math.abs(report.totals.labour_pct - (report.totals.labour_cost / 23.17) * 100) < 0.05);
    assert.deepEqual(report.top_items.slice(0, 2).map((i) => [i.name, i.net_sales]), [['Croissant', 9], ['Flat white', 8.75]]);

    const dash = (await manager('/dashboard')).data.locations[0];
    assert.equal(dash.sales_today, 9);
    assert.equal(typeof dash.labour_pct_today, 'number');

    const rota = (await manager('/rota')).data;
    assert.equal(rota.daily_money.find((m) => m.date === today()).net_sales, 9);

    const waste = (await manager('/wastage/report')).data;
    assert.equal(waste.sales.net_sales, 23.17);
  });

  test('staff cannot see sales and bad tokens give a clear error', async () => {
    const staff = await login('staff1@cafe.local');
    assert.equal((await staff('/sales')).status, 403);
    assert.equal((await staff('/rota')).data.daily_money, undefined);
    assert.equal((await staff('/wastage/report')).data.sales, null);

    const bad = new SquareClient({ ...square.config, token: 'wrong' });
    await assert.rejects(bad.listLocations(), /could not be authorized.*SQUARE_ACCESS_TOKEN/);
  });
});

describe('labour to date', () => {
  test('counts only hours worked so far today and nothing for future days', async () => {
    const { labourByDay } = await import('../src/metrics.js');
    const mem = openDb(':memory:');
    mem.prepare(`INSERT INTO locations (id, name) VALUES (1, 'A')`).run();
    mem.prepare(`INSERT INTO users (id, name, email, password_hash, role, location_id, hourly_rate) VALUES (1, 'X', 'x@x', 'x', 'staff', 1, 12)`).run();
    // 08:00–16:30 with a 30 minute break = 8 paid hours
    mem.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (1, 1, '2026-05-04', '08:00', '16:30', 30), (1, 1, '2026-05-05', '08:00', '16:30', 30)`).run();
    const asOf = { date: '2026-05-04', minutes: 12 * 60 + 15 }; // 12:15, 4h15m into the shift
    const planned = labourByDay(mem, [1], '2026-05-04', '2026-05-05');
    const worked = labourByDay(mem, [1], '2026-05-04', '2026-05-05', { toDate: true, asOf });
    assert.equal(planned.get('1|2026-05-04'), 96);
    assert.equal(planned.get('1|2026-05-05'), 96);
    assert.equal(Math.round(worked.get('1|2026-05-04') * 100) / 100, 48);
    assert.equal(worked.get('1|2026-05-05'), 0);
  });
});
