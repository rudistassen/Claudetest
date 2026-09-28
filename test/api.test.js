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

describe('rota across sites', () => {
  test('admins see every site at once and can put someone on at another site', async () => {
    const admin = await login('admin@cafe.local');
    const all = (await admin('/rota?location_id=all&week=2030-01-07')).data;
    assert.equal(all.location_id, 'all');
    const sites = new Set(all.staff.map((u) => u.location_name));
    assert.ok(sites.size >= 7, 'staff from every site, with their home site');
    const names = all.staff.map((u) => u.location_name);
    assert.deepEqual(names, [...names].sort((a, b) => (a ?? '~').localeCompare(b ?? '~')), 'grouped by home site');

    // Someone based at site 1 covers a shift at site 2.
    const person = all.staff.find((u) => u.location_id === 1 && u.role === 'staff');
    const cover = await admin('/shifts', { method: 'POST', body: { location_id: 2, user_id: person.id, date: '2030-01-08', start_time: '09:00', end_time: '13:00' } });
    assert.equal(cover.status, 201);
    assert.equal(cover.data.location_name, all.staff.find((u) => u.location_id === 2).location_name);

    const home = (await admin('/rota?location_id=1&week=2030-01-07')).data;
    assert.deepEqual(home.away_shifts.map((a) => [a.user_id, a.location_id, a.date]), [[person.id, 2, '2030-01-08']], 'shown greyed on their home rota');
    assert.ok(!home.shifts.some((x) => x.id === cover.data.id));
    const there = (await admin('/rota?location_id=2&week=2030-01-07')).data;
    assert.ok(there.staff.some((u) => u.id === person.id), 'listed as cover at site 2');
    const everyone = (await admin('/rota?location_id=all&week=2030-01-07')).data;
    assert.ok(everyone.shifts.some((x) => x.id === cover.data.id));
    assert.equal(everyone.away_shifts.length, 0);

    // Moving the shift to site 3 by editing it.
    const moved = await admin(`/shifts/${cover.data.id}`, { method: 'PUT', body: { location_id: 3, user_id: person.id, date: '2030-01-08', start_time: '09:00', end_time: '13:00' } });
    assert.equal(moved.data.location_id, 3);
    const clash = await admin('/shifts', { method: 'POST', body: { location_id: 1, user_id: person.id, date: '2030-01-08', start_time: '12:00', end_time: '16:00' } });
    assert.equal(clash.status, 400, 'still no double-booking across sites');

    // Copying a week at every site keeps each shift at its own site.
    const copy = await admin('/rota/copy-week', { method: 'POST', body: { location_id: 'all', from_week: '2030-01-07', to_week: '2030-01-14' } });
    assert.equal(copy.data.copied, 1);
    const nextWeek = (await admin('/rota?location_id=all&week=2030-01-14')).data;
    assert.deepEqual(nextWeek.shifts.map((x) => [x.user_id, x.location_id, x.date]), [[person.id, 3, '2030-01-15']]);
  });

  test('managers only run their own site', async () => {
    const manager = await login('manager1@cafe.local');
    const me = (await manager('/auth/me')).data.user;
    assert.equal((await manager('/rota?location_id=all')).status, 400);
    const staff = (await manager('/rota')).data.staff.find((u) => u.role === 'staff');
    const other = me.location_id === 1 ? 2 : 1;
    const r = await manager('/shifts', { method: 'POST', body: { location_id: other, user_id: staff.id, date: '2030-02-04', start_time: '09:00', end_time: '12:00' } });
    assert.equal(r.status, 403);
  });
});

describe('rota publishing', () => {
  test('staff only see shifts once they are published', async () => {
    const admin = await login('admin@cafe.local');
    const d = addDays(today(), 2);
    const week = weekStart(d);
    // A new starter at site 1, so their shifts don't clash with the demo rota.
    const person = (await admin('/users', { method: 'POST', body: { name: 'Pat Publish', email: 'pat@cafe.local', role: 'staff', location_id: 1, password: DEMO_PASSWORD } })).data;
    const pat = await login('pat@cafe.local');
    const shift = (await admin('/shifts', { method: 'POST', body: { location_id: 1, user_id: person.id, date: d, start_time: '09:00', end_time: '13:00' } })).data;

    const draft = (await admin(`/rota?location_id=1&week=${week}`)).data;
    assert.equal(draft.shifts.find((x) => x.id === shift.id).state, 'new');
    assert.ok(draft.unpublished >= 1);
    assert.equal(draft.can_publish, true);
    const seen = async () => (await pat(`/rota?week=${week}`)).data.shifts.filter((x) => x.user_id === person.id).map((x) => `${x.start_time}-${x.end_time}`);
    assert.deepEqual(await seen(), [], 'not published yet');
    assert.equal((await pat(`/rota?week=${week}`)).data.unpublished, undefined, 'staff are not told about drafts');
    assert.deepEqual((await pat('/my-shifts')).data, []);
    assert.equal((await pat('/rota/publish', { method: 'POST', body: { week } })).status, 403);

    const pub = await admin('/rota/publish', { method: 'POST', body: { location_id: 1, week } });
    assert.ok(pub.data.published >= 1);
    assert.deepEqual(await seen(), ['09:00-13:00']);
    assert.equal((await pat('/my-shifts')).data.length, 1);
    assert.equal((await admin(`/rota?location_id=1&week=${week}`)).data.unpublished, 0);

    // A change stays a draft: staff keep seeing the published times.
    await admin(`/shifts/${shift.id}`, { method: 'PUT', body: { location_id: 1, user_id: person.id, date: d, start_time: '10:00', end_time: '14:00' } });
    const changed = (await admin(`/rota?location_id=1&week=${week}`)).data.shifts.find((x) => x.id === shift.id);
    assert.equal(changed.state, 'changed');
    assert.deepEqual([changed.published.start_time, changed.published.end_time], ['09:00', '13:00']);
    assert.deepEqual(await seen(), ['09:00-13:00']);

    // Discarding goes back to what's published.
    const discard = await admin('/rota/discard', { method: 'POST', body: { location_id: 1, week } });
    assert.equal(discard.data.discarded, 1);
    assert.equal((await admin(`/rota?location_id=1&week=${week}`)).data.shifts.find((x) => x.id === shift.id).start_time, '09:00');

    // Deleting a published shift keeps it visible to staff until the rota is published again.
    await admin(`/shifts/${shift.id}`, { method: 'DELETE' });
    assert.equal((await admin(`/rota?location_id=1&week=${week}`)).data.shifts.find((x) => x.id === shift.id).state, 'removed');
    assert.deepEqual(await seen(), ['09:00-13:00']);
    const again = await admin('/shifts', { method: 'POST', body: { location_id: 1, user_id: person.id, date: d, start_time: '09:30', end_time: '12:00' } });
    assert.equal(again.status, 201, 'a removed shift no longer blocks the slot');
    await admin(`/shifts/${again.data.id}`, { method: 'DELETE' });
    assert.equal((await admin(`/shifts/${shift.id}/restore`, { method: 'POST' })).status, 200);
    assert.equal((await admin(`/rota?location_id=1&week=${week}`)).data.shifts.find((x) => x.id === shift.id).state, 'published');
    await admin(`/shifts/${shift.id}`, { method: 'DELETE' });
    await admin('/rota/publish', { method: 'POST', body: { location_id: 1, week } });
    assert.deepEqual(await seen(), []);
    assert.equal((await admin(`/rota?location_id=1&week=${week}`)).data.shifts.some((x) => x.id === shift.id), false);
  });

  test('editing and publishing are separate permissions', async () => {
    const admin = await login('admin@cafe.local');
    const manager = await login('manager1@cafe.local');
    const week = weekStart(addDays(today(), 21));
    assert.equal((await manager('/rota/publish', { method: 'POST', body: { week } })).status, 200, 'managers can publish');
    const set = (await admin('/permission-sets', { method: 'POST', body: { name: 'Rota drafter', permissions: ['rota.view', 'rota.edit'] } })).data;
    const staff = (await admin('/users')).data.find((u) => u.email === 'staff1@cafe.local');
    await admin(`/users/${staff.id}`, { method: 'PUT', body: { name: staff.name, email: staff.email, location_id: staff.location_id, hourly_rate: staff.hourly_rate, permission_set_id: set.id } });
    const drafter = await login('staff1@cafe.local');
    const rota = (await drafter(`/rota?week=${week}`)).data;
    assert.equal(rota.can_publish, false);
    assert.equal((await drafter('/rota/publish', { method: 'POST', body: { week } })).status, 403);
    assert.equal((await drafter('/rota/discard', { method: 'POST', body: { week } })).status, 200);
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
