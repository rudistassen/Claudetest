import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { emailOn, memoryMailer } from '../src/email.js';
import { memoryMailbox } from '../src/mailbox.js';
import { runDueReports } from '../src/reports.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;
let db;
const mailer = memoryMailer();
const orders = memoryMailbox([], 'orders@brewandbarrel.co.uk');
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'owner@atlas.test', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { mailer, orders }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setOn = (admin, map) => admin('/admin/email-settings', { method: 'PUT', body: { kinds: Object.fromEntries(Object.entries(map).map(([k, on]) => [k, { on }])) } });

test('each kind of email has a switch: what Atlas already sent starts on, rota emails start off', async () => {
  for (const k of ['invites', 'reports', 'payments', 'orders']) assert.equal(emailOn(db, k), true, k);
  assert.equal(emailOn(db, 'rota'), false);
  const admin = await login('owner@atlas.test');
  const kinds = (await admin('/admin/email-settings')).data.kinds;
  assert.deepEqual(kinds.map((k) => [k.key, k.on]), [['default', true], ['invites', true], ['rota', false], ['reports', true], ['payments', true], ['orders', true]]);
});

test('publishing the rota emails the people whose shifts changed their week – only once switched on', async () => {
  const admin = await login('owner@atlas.test');
  const person = db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();
  db.prepare(`UPDATE users SET email = 'jordan@brew.test' WHERE id = ?`).run(person.id);
  const other = db.prepare(`SELECT id FROM users WHERE location_id = ? AND id != ? AND role = 'staff' LIMIT 1`).get(person.location_id, person.id);
  db.prepare(`UPDATE users SET email = 'casey@brew.test' WHERE id = ?`).run(other.id);
  const week = weekStart(addDays(today(), 21));
  const add = (date, start, end) => admin('/shifts', { method: 'POST', body: { location_id: person.location_id, user_id: person.id, date, start_time: start, end_time: end, break_minutes: 30 } });

  // Off: publishing sends nothing.
  assert.equal((await add(week, '08:00', '16:30')).status, 201);
  const before = mailer.sent.length;
  assert.equal((await admin('/rota/publish', { method: 'POST', body: { location_id: person.location_id, week } })).status, 200);
  await wait(50);
  assert.equal(mailer.sent.length, before, 'nothing while switched off');

  // On: the change goes out, with their whole week.
  assert.equal((await setOn(admin, { rota: true })).status, 200);
  assert.equal((await add(addDays(week, 2), '10:00', '14:00')).status, 201);
  await admin('/rota/publish', { method: 'POST', body: { location_id: person.location_id, week } });
  await wait(50);
  const mine = mailer.sent.slice(before).filter((e) => e.to === 'jordan@brew.test');
  assert.equal(mine.length, 1);
  assert.ok(!mailer.sent.slice(before).some((e) => e.to === 'casey@brew.test'), 'people whose shifts didn’t change aren’t emailed');
  const email = mine[0];
  assert.match(email.subject, /^Your shifts for the week of /);
  assert.match(email.text, /08:00–16:30 at /);
  assert.match(email.text, /10:00–14:00 at /);
  assert.match(email.text, /Day off/);
  assert.match(email.text, /Total: 11.5 hours/);

  // A single shift published on its own emails them too.
  const one = await add(addDays(week, 4), '12:00', '15:00');
  await admin(`/shifts/${one.data.id}/publish`, { method: 'POST' });
  await wait(50);
  assert.match(mailer.sent.at(-1).text, /12:00–15:00/);
  await setOn(admin, { rota: false });
});

test('switched-off emails aren’t sent: invites, password resets, reports and supplier orders', async () => {
  const admin = await login('owner@atlas.test');
  await setOn(admin, { invites: false, reports: false, orders: false });
  const someone = db.prepare(`SELECT id FROM users WHERE role = 'staff' LIMIT 1`).get();
  db.prepare(`UPDATE users SET email = 'new.person@brew.test' WHERE id = ?`).run(someone.id);
  const invite = await admin('/users/invite', { method: 'POST', body: { ids: [someone.id] } });
  assert.equal(invite.status, 400);
  assert.match(invite.data.error, /switched off/);

  const count = mailer.sent.length;
  const forgot = await (await fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new.person@brew.test' }) })).json();
  assert.equal(forgot.email_ready, false);
  assert.equal(mailer.sent.length, count);

  db.prepare(`INSERT INTO report_schedules (name, send_time, days, period, active) VALUES ('Daily', '00:00', '0123456', 'today', 1)`).run();
  await runDueReports(db, mailer, { log: { log() {}, error() {} } });
  assert.equal(mailer.sent.length, count, 'no reports while switched off');

  const o = db.prepare(`INSERT INTO purchase_orders (location_id, supplier_id) VALUES ((SELECT MIN(id) FROM locations), (SELECT MIN(id) FROM suppliers))`).run().lastInsertRowid;
  const r = await admin(`/orders/${o}/email`, { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /switched off/);
  assert.equal((await admin(`/orders/${o}/emails`)).data.enabled, false);

  // The test button still works, so a sender can be checked before switching on.
  const t = await admin('/admin/email-settings/test', { method: 'POST', body: { kind: 'invites' } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const rotaTest = await admin('/admin/email-settings/test', { method: 'POST', body: { kind: 'rota' } });
  assert.equal(rotaTest.status, 200, JSON.stringify(rotaTest.data));
  assert.match(mailer.sent.at(-1).subject, /^Your shifts for the week of /);
  await setOn(admin, { invites: true, reports: true, orders: true });
});
