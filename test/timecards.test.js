import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient } from '../src/square.js';
import { today } from '../src/util.js';

// A pretend Square with one clock-in, recording what Brewly sends.
const sent = [];
let refuse = false;
const card = {
  id: 'TC1', location_id: 'SQ_A', team_member_id: 'TM1', start_at: `${today()}T08:00:00Z`, end_at: `${today()}T12:00:00Z`,
  wage: { title: 'Barista', hourly_rate: { amount: 1200, currency: 'GBP' } }, breaks: [], status: 'CLOSED', version: 3,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/v2/labor/break-types') {
    return json(200, { break_types: [
      { id: 'BT_LUNCH', break_name: 'Lunch', expected_duration: 'PT30M', is_paid: false },
      { id: 'BT_TEA', break_name: 'Tea', expected_duration: 'PT10M', is_paid: true },
    ] });
  }
  if (path !== '/v2/labor/shifts/TC1') return json(404, { errors: [{ detail: 'Not found' }] });
  if ((init.method ?? 'GET') === 'GET') return json(200, { shift: card });
  const body = JSON.parse(init.body);
  sent.push(body);
  if (refuse) return json(400, { errors: [{ code: 'INVALID_VALUE', detail: 'Team member is not assigned to this location' }] });
  Object.assign(card, body.shift, { version: card.version + 1 });
  card.breaks = (card.breaks ?? []).map((b, i) => ({ id: b.id ?? `BR${card.version}_${i}`, ...b }));
  return json(200, { shift: card });
}

let server;
let base;
let db;
let siteA;
let siteB;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  [siteA, siteB] = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 2').all().map((l) => l.id);
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_A' WHERE id = ?`).run(siteA);
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_B' WHERE id = ?`).run(siteB);
  const staff = db.prepare('SELECT id FROM users WHERE location_id = ? AND role = ? LIMIT 1').get(siteA, 'staff').id;
  db.prepare(`INSERT INTO square_team_members (id, name, user_id) VALUES ('TM1', 'Jo', ?)`).run(staff);
  db.prepare(`INSERT INTO timecards (id, location_id, team_member_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status)
    VALUES ('TC1', ?, 'TM1', ?, ?, ?, ?, 0, 12, 'CLOSED')`).run(siteA, staff, today(), card.start_at, card.end_at);
  const config = { token: 't', environment: 'production', baseUrl: 'https://square.test', version: '2025-01-23' };
  server = createApp(db, { square: { config, client: new SquareClient(config, fakeFetch) } }).listen(0);
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

test('a clock-in can be moved to another site: changed in Square, in Brewly and in the rota changes log', async () => {
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteB } })).status, 403);

  const admin = await login('admin@cafe.local');
  refuse = true;
  const refused = await admin('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteB } });
  assert.equal(refused.status, 502);
  assert.match(refused.data.error, /Square didn’t accept the change: Team member is not assigned/);
  assert.equal(db.prepare(`SELECT location_id FROM timecards WHERE id = 'TC1'`).get().location_id, siteA, 'unchanged when Square refuses');

  refuse = false;
  const moved = await admin('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteB } });
  assert.equal(moved.status, 200);
  const body = sent.at(-1).shift;
  assert.equal(body.location_id, 'SQ_B');
  assert.equal(body.version, 3, 'Square checks nobody else changed it meanwhile');
  assert.equal(body.created_at, undefined, 'read-only fields are left out');
  assert.equal(body.team_member_id, 'TM1');
  assert.deepEqual(body.wage, card.wage);
  assert.equal(db.prepare(`SELECT location_id FROM timecards WHERE id = 'TC1'`).get().location_id, siteB);

  const log = db.prepare(`SELECT * FROM rota_log WHERE action = 'timecard_site'`).get();
  assert.equal(log.location_id, siteB);
  assert.equal(log.hours, 4);
  assert.match(log.details, /^Clock-in \d\d:\d\d–\d\d:\d\d moved from .+ to .+$/);
  const listed = await admin(`/rota/log?action=timecard_site&from=${today()}&to=${today()}`);
  assert.equal(listed.status, 200);

  assert.equal((await admin('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteB } })).status, 400, 'already there');
  const unlinked = db.prepare('SELECT id FROM locations WHERE square_location_id IS NULL AND active = 1 LIMIT 1').get().id;
  assert.equal((await admin('/timecards/TC1/location', { method: 'PUT', body: { location_id: unlinked } })).status, 400);
});

test('moving clock-ins is its own permission: in the Manager set, not Staff, and added to existing Manager sets', async () => {
  const sets = Object.fromEntries(db.prepare('SELECT built_in, permissions FROM permission_sets WHERE built_in IS NOT NULL').all().map((s) => [s.built_in, JSON.parse(s.permissions)]));
  assert.ok(sets.manager.includes('timecards.move'));
  assert.ok(!sets.staff.includes('timecards.move'));

  // A manager whose set doesn't have it can't move clock-ins, even though they manage staff.
  const manager = db.prepare(`SELECT id, location_id FROM users WHERE role = 'manager' AND location_id = ? LIMIT 1`).get(siteA);
  db.prepare('UPDATE users SET all_sites = 1 WHERE id = ?').run(manager.id);
  const custom = db.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Supervisor', '', ?)`)
    .run(JSON.stringify(sets.manager.filter((p) => p !== 'timecards.move'))).lastInsertRowid;
  db.prepare('UPDATE users SET permission_set_id = ? WHERE id = ?').run(custom, manager.id);
  const email = db.prepare('SELECT email FROM users WHERE id = ?').get(manager.id).email;
  let call = await login(email);
  assert.equal((await call('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteA } })).status, 403);
  db.prepare('UPDATE users SET permission_set_id = NULL WHERE id = ?').run(manager.id);
  call = await login(email);
  assert.equal((await call('/timecards/TC1/location', { method: 'PUT', body: { location_id: siteA } })).status, 200, 'with the Manager set they can');

  // Databases from before this permission existed: the Manager set gets it, other sets don't.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'brewly-'));
  const file = join(dir, 'old.db');
  let old = openDb(file);
  old.prepare(`UPDATE permission_sets SET permissions = '["staff.manage"]'`).run();
  old.exec('PRAGMA user_version = 2');
  old.close();
  old = openDb(file);
  const after = Object.fromEntries(old.prepare('SELECT built_in, permissions FROM permission_sets').all().map((s) => [s.built_in, JSON.parse(s.permissions)]));
  assert.ok(after.manager.includes('timecards.move'));
  assert.ok(!after.staff.includes('timecards.move'));
  old.close();
  rmSync(dir, { recursive: true, force: true });
});

test('breaks can be added, changed and removed on a clock-in, in Square and Brewly', async () => {
  const admin = await login('admin@cafe.local');
  const staff = await login('staff1@cafe.local');
  const url = '/timecards/TC1/breaks';
  assert.equal((await staff(url)).status, 403);
  // Times are UK local; the clock-in is 08:00–12:00 UTC.
  const local = (utcHour) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(`${today()}T${String(utcHour).padStart(2, '0')}:00:00Z`));
  const t = (h, m) => local(h).replace(/:00$/, `:${m}`);

  const view = await admin(url);
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.breaks, []);
  assert.deepEqual(view.data.break_types.map((b) => b.name), ['Lunch', 'Tea']);

  // Checks: inside the clock-in, ends after it starts, no overlaps.
  const save = (breaks) => admin(url, { method: 'PUT', body: { breaks } });
  assert.equal((await save([{ break_type_id: 'BT_LUNCH', start: t(7, '30'), end: t(8, '00') }])).status, 400, 'before clock-in');
  assert.equal((await save([{ break_type_id: 'BT_LUNCH', start: t(10, '30'), end: t(10, '00') }])).status, 400);
  assert.equal((await save([{ break_type_id: 'BT_LUNCH', start: t(10, '00'), end: t(10, '30') }, { break_type_id: 'BT_TEA', start: t(10, '20'), end: t(10, '40') }])).status, 400);
  assert.equal((await save([{ break_type_id: 'BT_LUNCH', start: '10.00', end: t(10, '30') }])).status, 400);

  const added = await save([{ break_type_id: 'BT_LUNCH', start: t(10, '00'), end: t(10, '30') }, { break_type_id: 'BT_TEA', start: t(9, '00'), end: t(9, '10') }]);
  assert.equal(added.status, 200);
  assert.equal(added.data.changes.length, 2);
  const put = sent.at(-1).shift;
  assert.equal(put.location_id, card.location_id, 'still at the same site');
  assert.deepEqual(put.breaks.map((b) => [b.name, b.start_at, b.end_at, b.is_paid, b.expected_duration]), [
    ['Tea', `${today()}T09:00:00.000Z`, `${today()}T09:10:00.000Z`, true, 'PT10M'],
    ['Lunch', `${today()}T10:00:00.000Z`, `${today()}T10:30:00.000Z`, false, 'PT30M'],
  ]);
  let row = db.prepare(`SELECT unpaid_break_minutes, breaks_synced FROM timecards WHERE id = 'TC1'`).get();
  assert.equal(row.unpaid_break_minutes, 30, 'only the unpaid lunch comes off');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM timecard_breaks WHERE timecard_id = 'TC1'`).get().n, 2);

  // Change the lunch and remove the tea break.
  const lunch = (await admin(url)).data.breaks.find((b) => b.name === 'Lunch');
  const changed = await save([{ id: lunch.id, break_type_id: 'BT_LUNCH', start: t(10, '15'), end: t(10, '45') }]);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.changes.length, 2);
  assert.ok(changed.data.changes.some((c) => c.startsWith('changed Lunch')));
  assert.ok(changed.data.changes.some((c) => c.startsWith('removed Tea')));
  assert.equal(sent.at(-1).shift.breaks[0].id, lunch.id, 'the same break is changed, not replaced');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM timecard_breaks WHERE timecard_id = 'TC1'`).get().n, 1);

  const before = sent.length;
  assert.equal((await save([{ id: lunch.id, break_type_id: 'BT_LUNCH', start: t(10, '15'), end: t(10, '45') }])).data.changed, false);
  assert.equal(sent.length, before, 'nothing sent to Square when nothing changed');
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE action = 'timecard_breaks' AND details LIKE '%removed Tea%'`).get());
  row = db.prepare(`SELECT unpaid_break_minutes FROM timecards WHERE id = 'TC1'`).get();
  assert.equal(row.unpaid_break_minutes, 30);
});
