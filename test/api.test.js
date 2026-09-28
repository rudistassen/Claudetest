import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, shiftHours, today, weekStart } from '../src/util.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return call;
}

describe('auth', () => {
  test('rejects unauthenticated and bad credentials', async () => {
    assert.equal((await fetch(`${base}/dashboard`)).status, 401);
    const bad = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@cafe.local', password: 'nope' }),
    });
    assert.equal(bad.status, 401);
  });

  test('never exposes password hashes', async () => {
    const admin = await login('admin@cafe.local');
    const { data } = await admin('/users');
    assert.ok(data.length > 30);
    assert.ok(data.every((u) => !('password_hash' in u)));
  });
});

describe('location access', () => {
  test('admin sees all 7 sites, managers only their own', async () => {
    const admin = await login('admin@cafe.local');
    const manager = await login('manager1@cafe.local');
    assert.equal((await admin('/dashboard')).data.locations.length, 7);
    const mine = (await manager('/dashboard')).data.locations;
    assert.equal(mine.length, 1);
    const other = mine[0].id === 1 ? 2 : 1;
    assert.equal((await manager(`/rota?location_id=${other}`)).status, 403);
    assert.equal((await manager(`/safety/checklist?location_id=${other}`)).status, 403);
  });

  test('staff cannot use manager-only features or see pay rates', async () => {
    const staff = await login('staff1@cafe.local');
    assert.equal((await staff('/orders')).status, 403);
    assert.equal((await staff('/users')).status, 403);
    const rota = (await staff('/rota')).data;
    assert.equal(rota.labour_cost, undefined);
    assert.ok(rota.staff.every((u) => !('hourly_rate' in u)));
  });

  test('managers can only create staff at their own site', async () => {
    const manager = await login('manager1@cafe.local');
    const me = (await manager('/auth/me')).data.user;
    const ok = await manager('/users', { method: 'POST', body: { name: 'New Starter', email: 'new@cafe.local', role: 'staff', location_id: me.location_id, password: 'password123' } });
    assert.equal(ok.status, 201);
    const other = await manager('/users', { method: 'POST', body: { name: 'X', email: 'x@cafe.local', role: 'staff', location_id: me.location_id + 1, password: 'password123' } });
    assert.equal(other.status, 403);
    const promote = await manager('/users', { method: 'POST', body: { name: 'Y', email: 'y@cafe.local', role: 'manager', location_id: me.location_id, password: 'password123' } });
    assert.equal(promote.status, 403);
  });
});

describe('rota', () => {
  test('calculates hours including overnight shifts', () => {
    assert.equal(shiftHours('07:00', '15:30', 30), 8);
    assert.equal(shiftHours('22:00', '02:00', 0), 4);
  });

  test('prevents double-booking across sites and copies weeks', async () => {
    const admin = await login('admin@cafe.local');
    const rota = (await admin('/rota?location_id=1')).data;
    const s = rota.shifts[0];
    const clash = await admin('/shifts', { method: 'POST', body: { location_id: 2, user_id: s.user_id, date: s.date, start_time: s.start_time, end_time: s.end_time } });
    assert.equal(clash.status, 400);
    assert.match(clash.data.error, /already has a shift/);

    const nextWeek = addDays(rota.week_start, 7);
    const copy = await admin('/rota/copy-week', { method: 'POST', body: { location_id: 1, from_week: rota.week_start, to_week: nextWeek } });
    assert.equal(copy.data.copied, rota.shifts.length);
    const again = await admin('/rota/copy-week', { method: 'POST', body: { location_id: 1, from_week: rota.week_start, to_week: nextWeek } });
    assert.equal(again.data.copied, 0);
    assert.equal(again.data.skipped, rota.shifts.length);
  });
});

describe('stock takes and ordering', () => {
  test('suggested order quantities come from par minus last count', async () => {
    const manager = await login('manager3@cafe.local');
    const locationId = (await manager('/auth/me')).data.user.location_id;
    const before = (await manager(`/orders/suggest?supplier_id=1`)).data;
    assert.equal(before.last_stock_take, null);
    assert.ok(before.products.every((p) => p.suggested === 0));

    const take = (await manager('/stocktakes', { method: 'POST', body: {} })).data;
    assert.equal(take.status, 'in_progress');
    const detail = (await manager(`/stocktakes/${take.id}`)).data;
    const milk = detail.lines.find((l) => l.name === 'Whole milk 4L');
    await manager(`/stocktakes/${take.id}/lines`, { method: 'PUT', body: { lines: [{ product_id: milk.product_id, counted_quantity: 5 }] } });

    const early = await manager(`/stocktakes/${take.id}/complete`, { method: 'POST', body: {} });
    assert.equal(early.status, 400, 'uncounted items block completion unless confirmed');
    const done = await manager(`/stocktakes/${take.id}/complete`, { method: 'POST', body: { zero_uncounted: true } });
    assert.equal(done.data.status, 'completed');
    assert.equal(done.data.total_value, 5 * milk.unit_cost);

    // Per-site par override
    await manager(`/products/${milk.product_id}/pars`, { method: 'PUT', body: { pars: [{ location_id: locationId, par_level: 20 }] } });
    const s = (await manager('/orders/suggest?supplier_id=1')).data;
    assert.equal(s.products.find((p) => p.product_id === milk.product_id).suggested, 15);
    const cream = s.products.find((p) => p.name === 'Double cream 1L');
    assert.equal(cream.suggested, cream.par_level);
  });

  test('order lifecycle: draft → sent → received', async () => {
    const manager = await login('manager2@cafe.local');
    const products = (await manager('/products')).data;
    const bakery = products.filter((p) => p.supplier_name === 'Hearth Bakery');
    const wrongSupplier = products.find((p) => p.supplier_name === 'Valley Dairy');

    const mixed = await manager('/orders', { method: 'POST', body: { supplier_id: bakery[0].supplier_id, lines: [{ product_id: wrongSupplier.id, quantity: 1 }] } });
    assert.equal(mixed.status, 400);

    const order = (await manager('/orders', { method: 'POST', body: { supplier_id: bakery[0].supplier_id, lines: [{ product_id: bakery[0].id, quantity: 10 }, { product_id: bakery[1].id, quantity: 0 }] } })).data;
    assert.equal(order.status, 'draft');
    assert.equal(order.lines.length, 1);
    assert.equal(order.total, Math.round(10 * bakery[0].unit_cost * 100) / 100);

    assert.equal((await manager(`/orders/${order.id}/receive`, { method: 'POST', body: {} })).status, 400);
    assert.equal((await manager(`/orders/${order.id}/send`, { method: 'POST' })).data.status, 'sent');
    const received = (await manager(`/orders/${order.id}/receive`, { method: 'POST', body: { lines: [{ id: order.lines[0].id, received_quantity: 8 }] } })).data;
    assert.equal(received.status, 'received');
    assert.equal(received.lines[0].received_quantity, 8);

    const otherManager = await login('manager4@cafe.local');
    assert.equal((await otherManager(`/orders/${order.id}`)).status, 403);
  });
});

describe('wastage', () => {
  test('costs entries from the product and reports by reason', async () => {
    const staff = await login('staff5@cafe.local');
    const products = (await staff('/products')).data;
    const croissant = products.find((p) => p.name === 'Croissant');
    const r = await staff('/wastage', { method: 'POST', body: { product_id: croissant.id, quantity: 4, reason: 'Out of date' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.total_cost, 2.6);
    await staff('/wastage', { method: 'POST', body: { item_name: 'Ham toastie', quantity: 2, unit_cost: 1.5, reason: 'Over-production' } });
    assert.equal((await staff('/wastage', { method: 'POST', body: { item_name: 'X', quantity: 1, reason: 'Because' } })).status, 400);
    assert.equal((await staff('/wastage', { method: 'POST', body: { item_name: 'X', quantity: 1, reason: 'Other', date: addDays(today(), 1) } })).status, 400);

    const report = (await staff('/wastage/report')).data;
    assert.equal(report.total_cost, 5.6);
    assert.equal(report.by_reason[0].key, 'Over-production');

    const csv = await staff('/wastage/export.csv');
    assert.match(csv.data, /^Date,Location,Item/);
    assert.match(csv.data, /Croissant/);
  });
});

describe('food safety', () => {
  test('out-of-range readings fail and need a corrective action', async () => {
    const staff = await login('staff6@cafe.local');
    const list = (await staff('/safety/checklist')).data;
    const fridge = list.tasks.find((t) => t.title.startsWith('Display fridge temperature (opening)'));
    const weekly = list.tasks.find((t) => t.frequency === 'weekly' && !t.requires_reading);

    const missing = await staff('/safety/checks', { method: 'POST', body: { task_id: fridge.id, reading: 9 } });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /corrective action/);

    const fail = await staff('/safety/checks', { method: 'POST', body: { task_id: fridge.id, reading: 9, corrective_action: 'Moved food to walk-in' } });
    assert.equal(fail.data.status, 'fail');
    const redo = await staff('/safety/checks', { method: 'POST', body: { task_id: fridge.id, reading: 4 } });
    assert.equal(redo.data.status, 'pass');
    assert.equal(redo.data.id, fail.data.id, 'redoing a check updates the same record');

    await staff('/safety/checks', { method: 'POST', body: { task_id: weekly.id } });
    const after = (await staff('/safety/checklist')).data;
    assert.equal(after.tasks.find((t) => t.id === weekly.id).check.period, weekStart(today()));

    const future = await staff('/safety/checks', { method: 'POST', body: { task_id: fridge.id, reading: 3, date: addDays(today(), 1) } });
    assert.equal(future.status, 400);
  });

  test('compliance report counts completed checks', async () => {
    const manager = await login('manager6@cafe.local');
    const report = (await manager('/safety/report')).data;
    assert.equal(report.locations.length, 1);
    const todayRow = report.locations[0].days.find((d) => d.date === today());
    assert.equal(todayRow.done, 1);
    assert.equal(todayRow.due, 15);
    assert.equal(report.failures.length, 0, 'the failed reading was corrected');
  });

  test('staff cannot create checklist tasks', async () => {
    const staff = await login('staff6@cafe.local');
    assert.equal((await staff('/safety/tasks', { method: 'POST', body: { title: 'x', frequency: 'daily' } })).status, 403);
  });
});
