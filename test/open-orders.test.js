import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { SquareClient, syncSales } from '../src/square.js';
import { localDate } from '../src/util.js';

test('open orders count in today’s sales while open, and once (as a sale) when paid – never twice', async () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_A' WHERE id = ?`).run(site);
  const now = new Date(Date.now() - 30 * 60000).toISOString();
  const line = (pence) => ({ name: 'Item', quantity: '1', total_money: { amount: pence, currency: 'GBP' }, total_tax_money: { amount: Math.round(pence / 6), currency: 'GBP' } });
  let completed = [{ id: 'C1', location_id: 'SQ_A', state: 'COMPLETED', closed_at: now, line_items: [line(1000)] }];
  let open = [{ id: 'O1', location_id: 'SQ_A', state: 'OPEN', created_at: now, line_items: [line(600)] },
    { id: 'PL1', location_id: 'SQ_A', state: 'OPEN', created_at: now, line_items: [line(5000)] }];
  db.prepare(`INSERT INTO payment_links (location_id, square_link_id, square_order_id, url, amount, description) VALUES (?, 'L', 'PL1', 'u', 50, 'deposit')`).run(site);
  const fetchFn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    let data = {};
    if (path === '/v2/orders/search') data = { orders: body.query.filter.state_filter.states.includes('OPEN') ? open : completed };
    else if (path.includes('team-members')) data = { team_members: [] };
    else if (path.includes('labor')) data = { timecards: [] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const config = { token: 't', environment: 'production', baseUrl: 'https://square.test', version: '2025-05-21' };
  const client = new SquareClient(config, fetchFn);
  const day = localDate(Date.now());
  const get = () => db.prepare('SELECT gross_sales, orders, open_gross, open_orders FROM sales_daily WHERE location_id = ? AND date = ?').get(site, day);

  await syncSales(db, client, { from: day, to: day });
  assert.deepEqual({ ...get() }, { gross_sales: 16, orders: 2, open_gross: 6, open_orders: 1 }, 'the open tab is included; the payment link isn’t');

  // The tab is paid: it's now a completed order and no longer open.
  completed = [...completed, { ...open[0], state: 'COMPLETED', closed_at: new Date().toISOString() }];
  open = open.slice(1);
  await syncSales(db, client, { from: day, to: day });
  assert.deepEqual({ ...get() }, { gross_sales: 16, orders: 2, open_gross: 0, open_orders: 0 }, 'counted once');

  // A tab that's voided simply drops out.
  open = [...open, { id: 'O2', location_id: 'SQ_A', state: 'OPEN', created_at: now, line_items: [line(400)] }];
  await syncSales(db, client, { from: day, to: day });
  assert.equal(get().gross_sales, 20);
  open = open.filter((o) => o.id !== 'O2');
  await syncSales(db, client, { from: day, to: day });
  assert.equal(get().gross_sales, 16);
});
