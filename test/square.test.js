import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient, summariseOrder, summariseTimecard, syncSales } from '../src/square.js';
import { addDays, localHour, today, zonedMidnightUTC } from '../src/util.js';

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
let timecards = [];
let labourForbidden = false;
const requests = [];
const TEAM = [
  { id: 'TM_1', given_name: 'Someone', family_name: 'Else', email_address: 'MANAGER1@cafe.local', status: 'ACTIVE' },
  { id: 'TM_2', given_name: 'Casual', family_name: 'Carl', status: 'INACTIVE' },
  { id: 'TM_3', given_name: 'Priya', family_name: 'Shah', email_address: 'priya@example.com', status: 'ACTIVE',
    assigned_locations: { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: ['SQ_ELSEWHERE', 'SQ_HIGH'] },
    wage_setting: { job_assignments: [{ job_title: 'Barista', pay_type: 'HOURLY', hourly_rate: { amount: 1221, currency: 'GBP' } }] } },
  { id: 'TM_4', given_name: 'Sam', family_name: 'Noemail', status: 'ACTIVE', assigned_locations: { assignment_type: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' } },
  // Same email as TM_3, which Square allows but Cafe Ops can't.
  { id: 'TM_5', given_name: 'Priya', family_name: 'Twin', email_address: 'Priya@Example.com', status: 'ACTIVE' },
  { id: 'TM_6', given_name: 'Rudi', family_name: 'Owner', email_address: 'owner@example.com', status: 'ACTIVE', is_owner: true },
];

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
    if (req.method === 'POST' && (req.url === '/v2/team-members/search' || req.url === '/v2/labor/shifts/search') && labourForbidden) {
      return send(403, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'The merchant has not given your application sufficient permissions.' }] });
    }
    if (req.method === 'POST' && req.url === '/v2/team-members/search') return send(200, { team_members: TEAM });
    if (req.method === 'POST' && req.url === '/v2/labor/shifts/search') {
      const q = JSON.parse(body);
      const { start_at: start, end_at: end } = q.query.filter.start;
      const matching = timecards.filter((t) => q.query.filter.location_ids.includes(t.location_id) && t.start_at >= start && t.start_at < end);
      const offset = Number(q.cursor ?? 0);
      return send(200, { shifts: matching.slice(offset, offset + 2), ...(offset + 2 < matching.length ? { cursor: String(offset + 2) } : {}) });
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

describe('timecard summaries', () => {
  test('unpaid breaks are deducted, paid ones are not, and open timecards count up to now', () => {
    const t = summariseTimecard({
      id: 'tc', location_id: 'L', team_member_id: 'TM', start_at: '2026-07-01T06:00:00Z', end_at: '2026-07-01T14:30:00Z',
      wage: { title: 'Barista', hourly_rate: money(1250) },
      breaks: [
        { start_at: '2026-07-01T10:00:00Z', end_at: '2026-07-01T10:30:00Z', is_paid: false },
        { start_at: '2026-07-01T12:00:00Z', end_at: '2026-07-01T12:15:00Z', is_paid: true },
      ],
    }, 'Europe/London');
    assert.equal(t.date, '2026-07-01');
    assert.equal(t.unpaid_break_minutes, 30);
    assert.equal(t.hourly_rate, 12.5);
    assert.equal(t.status, 'CLOSED');

    const open = summariseTimecard({
      id: 'tc2', location_id: 'L', start_at: '2026-07-01T06:00:00Z',
      breaks: [{ start_at: '2026-07-01T09:00:00Z', is_paid: false }],
    }, 'Europe/London', Date.parse('2026-07-01T09:20:00Z'));
    assert.equal(open.end_at, null);
    assert.equal(open.status, 'OPEN');
    assert.equal(open.unpaid_break_minutes, 20, 'a break still running counts up to now');
    assert.equal(open.hourly_rate, null);
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
    const both = report.days.filter((d) => d.net_sales > 0 && d.labour_cost > 0);
    const expected = both.length ? (both.reduce((t, d) => t + d.labour_cost, 0) / both.reduce((t, d) => t + d.net_sales, 0)) * 100 : null;
    if (expected === null) assert.equal(report.totals.labour_pct, null);
    // Day figures are rounded to the penny, so allow for that relative to the (often large) percentage.
    else assert.ok(Math.abs(report.totals.labour_pct - expected) < Math.max(0.05, expected * 0.001));
    assert.deepEqual(report.top_items.slice(0, 2).map((i) => [i.name, i.net_sales]), [['Croissant', 9], ['Flat white', 8.75]]);

    const dash = (await manager('/dashboard')).data.locations[0];
    assert.equal(dash.sales_today, 9);
    assert.ok(dash.labour_pct_today === null || typeof dash.labour_pct_today === 'number');

    const rota = (await manager('/rota')).data;
    assert.equal(rota.daily_money.find((m) => m.date === today()).net_sales, 9);

    const waste = (await manager('/wastage/report')).data;
    assert.equal(waste.sales.net_sales, 23.17);
  });

  test('syncs clock-ins and the trading dashboard compares them with sales and the rota', async () => {
    const d = today();
    const y = addDays(d, -1);
    const at = (day, hh, mm = 0) => new Date(Date.parse(zonedMidnightUTC(day)) + (hh * 60 + mm) * 60000).toISOString();
    timecards = [
      // manager1 (matched by email, case-insensitively): 07:00–15:30 with a 30 minute unpaid break = 8 paid hours at £13.50
      { id: 'tc1', location_id: 'SQ_HIGH', team_member_id: 'TM_1', start_at: at(y, 7), end_at: at(y, 15, 30), status: 'CLOSED',
        wage: { title: 'Manager', hourly_rate: money(1350) }, breaks: [{ start_at: at(y, 11), end_at: at(y, 11, 30), is_paid: false }] },
      // Not an app user, and not on the rota: 2 hours with no wage
      { id: 'tc2', location_id: 'SQ_HIGH', team_member_id: 'TM_2', start_at: at(y, 10), end_at: at(y, 12), status: 'CLOSED' },
      { id: 'tc3', location_id: 'SQ_OTHER', team_member_id: 'TM_2', start_at: at(y, 10), end_at: at(y, 12), status: 'CLOSED' },
    ];
    requests.length = 0;
    const r = await syncSales(db, square.client, { from: y, to: d });
    assert.equal(r.timecards, 2);
    assert.equal(r.warning, null);
    const labourSearch = requests.filter((q) => q.url === '/v2/labor/shifts/search');
    assert.equal(labourSearch.length, 1);
    assert.equal(labourSearch[0].body.query.filter.start.start_at, zonedMidnightUTC(y));

    const manager1 = db.prepare(`SELECT id FROM users WHERE email = 'manager1@cafe.local'`).get().id;
    assert.equal(db.prepare(`SELECT user_id FROM square_team_members WHERE id = 'TM_1'`).get().user_id, manager1);
    assert.equal(db.prepare(`SELECT user_id FROM square_team_members WHERE id = 'TM_2'`).get().user_id, null);

    await syncSales(db, square.client, { from: y, to: d });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timecards').get().n, 2, 're-syncing replaces rather than duplicates');

    const manager = await login('manager1@cafe.local');
    const report = (await manager(`/trading?from=${y}&to=${d}`)).data;
    assert.equal(report.labour_synced, true);
    assert.equal(report.totals.clocked_hours, 10);
    assert.equal(report.totals.clocked_cost, 108);
    const yesterday = report.days.find((x) => x.date === y);
    assert.equal(yesterday.labour_pct, Math.round((108 / yesterday.net_sales) * 10000) / 100);
    assert.equal(yesterday.sales_per_labour_hour, Math.round((yesterday.net_sales / 10) * 100) / 100);

    // Hour-of-day sales add back up to the total, and the 07:00–15:30 + 10:00–12:00 clock-ins fill the right hours.
    assert.equal(report.trading_days, 2);
    const hourTotal = report.hours.reduce((t, h) => t + h.avg_net_sales * report.trading_days, 0);
    assert.ok(Math.abs(hourTotal - report.totals.net_sales) < 0.05);
    const staffAt = (h) => report.hours.find((x) => x.hour === h)?.avg_staff ?? 0;
    assert.equal(staffAt(6), 0);
    // 8 paid of 8.5 clocked hours, so each hour of manager1's timecard counts 0.94 of a person.
    assert.equal(staffAt(10), 1, '1.94 people for one of the 2 trading days');
    assert.equal(staffAt(14), 0.5);
    assert.equal(staffAt(15), 0.2, 'half an hour to 15:30');
    assert.equal(staffAt(16), 0);

    const carl = report.staff.find((p) => p.name === 'Casual Carl');
    assert.deepEqual([carl.clocked_hours, carl.clock_ins, carl.unrostered, carl.rostered_hours], [2, 1, 1, 0]);
    const myName = (await manager('/auth/me')).data.user.name;
    const me = report.staff.find((p) => p.name === myName);
    assert.equal(me.clocked_hours, 8);
  });

  test('sales still sync when the token cannot read clock-ins', async () => {
    labourForbidden = true;
    try {
      const r = await syncSales(db, square.client, { from: addDays(today(), -1), to: today() });
      assert.equal(r.orders, 3);
      assert.equal(r.timecards, null);
      assert.match(r.warning, /clock-ins were not.*sufficient permissions/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timecards').get().n, 2, 'keeps the clock-ins already stored');
      const log = db.prepare('SELECT * FROM square_sync_log ORDER BY id DESC LIMIT 1').get();
      assert.equal(log.status, 'ok');
      assert.match(log.message, /clock-ins were not/);
    } finally {
      labourForbidden = false;
    }
  });

  test('labour heatmap splits labour % by day of the week and hour', async () => {
    const d = today();
    const y = addDays(d, -1);
    const dowY = (new Date(`${y}T00:00:00Z`).getUTCDay() + 6) % 7;
    const manager = await login('manager1@cafe.local');
    const r = (await manager(`/trading/heatmap?from=${y}&to=${d}`)).data;
    assert.equal(r.basis, 'clocked');
    assert.equal(r.totals.net_sales, 23.17);
    assert.equal(r.totals.labour_cost, 108, "manager1's 8 paid hours at £13.50; Carl has no wage");
    assert.equal(r.weekdays[dowY].labour_cost, 108);
    assert.equal(r.weekdays[dowY].net_sales, 14.17);

    // The 09:00Z sale (£5.83 net) sits in its local hour, next to the labour clocked in that hour.
    const saleHour = localHour(`${y}T09:00:00Z`);
    const cell = r.cells.find((c) => c.dow === dowY && c.hour === saleHour);
    assert.equal(cell.net_sales, 5.83);
    assert.ok(Math.abs(cell.labour_pct - (cell.labour_cost / 5.83) * 100) < 0.2, 'labour cost ÷ sales (cost is rounded to the penny)');
    assert.ok(cell.labour_cost > 0);
    // 07:00–08:00 local: on the clock but no sales yet.
    const early = r.cells.find((c) => c.dow === dowY && c.hour === 7);
    assert.equal(early.net_sales, 0);
    assert.equal(early.labour_pct, null);
    assert.ok(Math.abs(early.labour_cost - 13.5 * (8 / 8.5)) < 0.01);
    const cellTotal = r.cells.reduce((t, c) => t + c.labour_cost, 0);
    assert.ok(Math.abs(cellTotal - 108) < 0.05, 'the cells add up to the total');

    const rostered = (await manager(`/trading/heatmap?from=${y}&to=${d}&basis=rostered`)).data;
    assert.equal(rostered.basis, 'rostered');
    assert.equal(rostered.totals.net_sales, 23.17);
    assert.equal((await manager('/trading/heatmap?basis=guess')).status, 400);
  });

  test('staff cannot see sales and bad tokens give a clear error', async () => {
    const staff = await login('staff1@cafe.local');
    assert.equal((await staff('/sales')).status, 403);
    assert.equal((await staff('/trading')).status, 403);
    assert.equal((await staff('/trading/heatmap')).status, 403);
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

describe('labour % without a rota', () => {
  test('days with sales but no shifts are left out rather than shown as 0%', async () => {
    const admin = await login('admin@cafe.local');
    const highId = db.prepare(`SELECT id FROM locations WHERE square_location_id = 'SQ_HIGH'`).get().id;
    const lastYear = addDays(today(), -365);
    db.prepare('INSERT INTO sales_daily (location_id, date, net_sales, orders) VALUES (?, ?, 500, 60)').run(highId, lastYear);
    const r = (await admin(`/sales?location_id=${highId}&from=${lastYear}&to=${lastYear}`)).data;
    assert.equal(r.totals.net_sales, 500);
    assert.equal(r.totals.labour_cost, 0);
    assert.equal(r.totals.labour_pct, null);
  });
});

// Runs last: importing with "deactivate others" switches off the demo staff the other tests sign in as.
describe('staff from Square', () => {
  test('previews, then imports the Square team as the staff list', async () => {
    const admin = await login('admin@cafe.local');
    const preview = (await admin('/square/team?deactivate_others=true')).data;
    const row = (name) => preview.find((r) => r.name === name);
    assert.equal(row('Someone Else').action, 'update', 'matched to manager1 by email');
    assert.equal(row('Someone Else').existing.email, 'manager1@cafe.local');
    assert.equal(row('Someone Else').role, 'manager', 'keeps their role');
    assert.equal(row('Casual Carl').action, 'skip');
    assert.deepEqual([row('Priya Shah').action, row('Priya Shah').site, row('Priya Shah').position, row('Priya Shah').hourly_rate],
      ['create', 'High Street', 'Barista', 12.21]);
    assert.equal(row('Sam Noemail').email, 'square-tm4@staff.local');
    assert.equal(row('Sam Noemail').no_email, true);
    assert.ok(preview.some((r) => r.action === 'deactivate' && r.existing.email === 'staff1@cafe.local'));
    assert.ok(!preview.some((r) => r.action === 'deactivate' && r.existing.email === 'admin@cafe.local'), 'never deactivates you');
    assert.deepEqual([row('Rudi Owner').action, row('Rudi Owner').existing.email, row('Rudi Owner').email, row('Rudi Owner').role],
      ['update', 'admin@cafe.local', 'admin@cafe.local', 'admin'], 'the Square owner is linked to you, keeping your sign-in email');
    assert.equal(row('Priya Twin').action, 'create');
    assert.equal(row('Priya Twin').email, 'square-tm5@staff.local', 'a duplicate email gets a placeholder instead of failing');
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'the preview changes nothing');

    const r = (await admin('/square/import-staff', { method: 'POST', body: { deactivate_others: true } })).data;
    assert.equal(r.created, 3);
    assert.equal(r.updated, 2);
    assert.ok(r.deactivated > 10);
    assert.deepEqual(r.need_password.sort(), ['Priya Shah', 'Priya Twin', 'Sam Noemail']);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n, 1, 'no second admin account for the owner');

    const manager1 = db.prepare(`SELECT * FROM users WHERE email = 'MANAGER1@cafe.local'`).get();
    assert.equal(manager1.name, 'Someone Else');
    assert.equal(manager1.active, 1);
    const priya = db.prepare(`SELECT u.*, l.name AS site FROM users u JOIN locations l ON l.id = u.location_id WHERE email = 'priya@example.com'`).get();
    assert.deepEqual([priya.role, priya.site, priya.position, priya.hourly_rate, priya.active], ['staff', 'High Street', 'Barista', 12.21, 1]);
    assert.equal(db.prepare(`SELECT user_id FROM square_team_members WHERE id = 'TM_3'`).get().user_id, priya.id);
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@cafe.local', password: DEMO_PASSWORD }) })).status, 401);
    assert.equal((await admin('/auth/me')).status, 200, 'the admin who ran it stays signed in');

    // A home site changed in Cafe Ops is kept when importing again, even though Square assigns them elsewhere.
    const kiosk = db.prepare(`SELECT id FROM locations WHERE square_location_id = 'SQ_NEW'`).get().id;
    const moved = await admin(`/users/${priya.id}`, { method: 'PUT', body: { name: 'Priya Shah', email: 'priya@example.com', role: 'staff', location_id: kiosk, position: 'Barista', hourly_rate: 12.21 } });
    assert.equal(moved.data.location_id, kiosk);
    const preview2 = (await admin('/square/team')).data;
    assert.equal(preview2.find((x) => x.name === 'Priya Shah').site, 'Airport Kiosk');
    const again = (await admin('/square/import-staff', { method: 'POST', body: { deactivate_others: true } })).data;
    assert.deepEqual([again.created, again.updated, again.deactivated], [0, 5, 0], 'running it again adds nobody twice');
    assert.equal(db.prepare('SELECT location_id FROM users WHERE id = ?').get(priya.id).location_id, kiosk, 'home site kept');
    assert.equal(db.prepare('SELECT hourly_rate FROM users WHERE id = ?').get(priya.id).hourly_rate, 12.21, 'details still come from Square');

    const clash = await admin(`/users/${priya.id}`, { method: 'PUT', body: { name: 'Priya Shah', email: 'MANAGER1@cafe.local', role: 'staff', location_id: priya.location_id } });
    assert.equal(clash.status, 400);
    assert.match(clash.data.error, /^Someone Else already uses that email/);
    assert.equal((await login('staff1@cafe.local').catch(() => null)), null);
  });
});
