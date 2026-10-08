import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { checkLate, setPushSender } from '../src/push.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;
let db;
const sent = [];
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  setPushSender(async (sub, payload) => {
    if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); setPushSender(null); });

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const take = (endpoint) => { const mine = sent.filter((x) => x.endpoint === endpoint); sent.length = 0; return mine; };
const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });

test('people turn notifications on, choose kinds, and get the right ones', async () => {
  const staff = await login('staff1@cafe.local');
  const site = staff.me.location_id;
  const mgrRow = db.prepare(`SELECT email FROM users WHERE role = 'manager' AND location_id = ? AND active = 1 ORDER BY id`).get(site);
  const manager = await login(mgrRow.email);
  const admin = await login('admin@cafe.local');

  // Setting up.
  const cfg = (await staff('/push')).data;
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.public_key);
  assert.ok(!cfg.kinds.some((k) => k.key === 'holiday_request'), 'staff don’t see manager kinds');
  assert.ok((await manager('/push')).data.kinds.some((k) => k.key === 'holiday_request'));
  assert.equal((await staff('/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'not-a-url' } } })).status, 400);
  assert.equal((await staff('/push/subscribe', { method: 'POST', body: sub('https://push.example/staff') })).status, 201);
  assert.equal((await manager('/push/subscribe', { method: 'POST', body: sub('https://push.example/mgr') })).status, 201);
  assert.equal((await staff('/push/test', { method: 'POST' })).data.sent, 1);
  take('');

  // Holiday: the request goes to the manager; the decision to the staff member.
  const start = addDays(today(), 30);
  const leave = await staff('/leave', { method: 'POST', body: { start_date: start, end_date: start } });
  await settle();
  const toMgr = take('https://push.example/mgr');
  assert.equal(toMgr[0]?.kind, 'holiday_request');
  assert.match(toMgr[0].body, new RegExp(staff.me.name));
  await manager(`/leave/${leave.data.id}/decide`, { method: 'POST', body: { status: 'approved' } });
  await settle();
  assert.deepEqual(take('https://push.example/staff').map((x) => [x.kind, x.title]), [['holiday_decision', 'Holiday approved ✓']]);

  // The rota: a new shift for them, published – their shifts changed; publishing again with no changes sends nothing.
  const week = weekStart(addDays(today(), 14));
  await admin('/shifts', { method: 'POST', body: { location_id: site, user_id: staff.me.id, date: addDays(week, 2), start_time: '09:00', end_time: '13:00' } });
  await admin('/rota/publish', { method: 'POST', body: { location_id: site, week } });
  await settle();
  const pub = take('https://push.example/staff');
  assert.deepEqual(pub.map((x) => x.kind), ['shift_changed']);
  assert.match(pub[0].page, new RegExp(`week=${week}`));
  await admin('/rota/publish', { method: 'POST', body: { location_id: site, week } });
  await settle();
  assert.equal(take('https://push.example/staff').length, 0);

  // Turning a kind off stops it.
  await staff('/push/prefs', { method: 'PUT', body: { kinds: { shift_changed: false } } });
  assert.equal((await staff('/push')).data.kinds.find((k) => k.key === 'shift_changed').on, false);
  const shift2 = await admin('/shifts', { method: 'POST', body: { location_id: site, user_id: staff.me.id, date: addDays(week, 3), start_time: '09:00', end_time: '13:00' } });
  await admin(`/shifts/${shift2.data.id}/publish`, { method: 'POST' });
  await settle();
  assert.equal(take('https://push.example/staff').length, 0);
  await staff('/push/prefs', { method: 'PUT', body: { kinds: { shift_changed: true } } });

  // Dropping a shift: the request to the manager; approval to them; the open shift to others at the site.
  const other = db.prepare('SELECT email FROM users WHERE location_id = ? AND active = 1 AND id NOT IN (?, ?) AND role = ? ORDER BY id').get(site, staff.me.id, manager.me.id, 'staff');
  const colleague = await login(other.email);
  await colleague('/push/subscribe', { method: 'POST', body: sub('https://push.example/colleague') });
  const drop = await staff(`/shifts/${shift2.data.id}/drop`, { method: 'POST', body: { reason: 'Dentist' } });
  assert.equal(drop.status, 201);
  await settle();
  assert.equal(take('https://push.example/mgr')[0]?.kind, 'drop_request');
  await manager(`/shift-drops/${drop.data.id}/approve`, { method: 'POST', body: {} });
  await settle();
  const after1 = [...sent];
  sent.length = 0;
  assert.ok(after1.some((x) => x.endpoint === 'https://push.example/staff' && x.kind === 'drop_decision'));
  assert.ok(after1.some((x) => x.endpoint === 'https://push.example/colleague' && x.kind === 'open_shift'));
  assert.ok(!after1.some((x) => x.endpoint === 'https://push.example/staff' && x.kind === 'open_shift'), 'not offered back to whoever dropped it');

  // News goes to everyone it's for.
  await admin('/news', { method: 'POST', body: { title: 'Team night out', body: 'Friday at 8', category: 'event', all_sites: true } });
  await settle();
  assert.ok(take('https://push.example/staff').some((x) => x.kind === 'news' && x.title === 'Team night out'));

  // A phone that's gone is forgotten.
  await staff('/push/subscribe', { method: 'POST', body: sub('https://push.example/gone') });
  await staff('/push/test', { method: 'POST' });
  await settle();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%gone%'`).get().n, 0);
  take('');
});

test('managers are told once when someone hasn’t clocked in', async () => {
  const staff = await login('staff2@cafe.local');
  const site = staff.me.location_id;
  const mgrRow = db.prepare(`SELECT id, email FROM users WHERE role = 'manager' AND location_id = ? AND active = 1 ORDER BY id`).get(site);
  const manager = await login(mgrRow.email);
  await manager('/push/subscribe', { method: 'POST', body: sub('https://push.example/mgr2') });
  const day = today();
  // Clock-ins come from Square at this site; this person has a published 08:00–16:00 shift and no clock-in.
  db.prepare(`INSERT INTO timecards (id, location_id, user_id, date, start_at, status) VALUES ('TC-other', ?, ?, ?, ?, 'OPEN')`).run(site, mgrRow.id, day, `${day}T07:00:00Z`);
  db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, pub_location_id, pub_user_id, pub_date, pub_start_time, pub_end_time, pub_break_minutes)
    VALUES (?, ?, ?, '08:00', '16:00', ?, ?, ?, '08:00', '16:00', 0)`).run(site, staff.me.id, day, site, staff.me.id, day);
  take('');
  assert.ok(checkLate(db, { now: '08:05', day }) >= 0);
  await settle();
  assert.ok(!take('https://push.example/mgr2').some((x) => x.kind === 'late' && x.body.includes('08:00–16:00')), 'not yet – only 5 minutes');
  checkLate(db, { now: '08:20', day });
  await settle();
  const late = take('https://push.example/mgr2').filter((x) => x.kind === 'late' && x.body.includes('08:00–16:00'));
  assert.equal(late.length, 1);
  assert.match(late[0].body, /20 minutes late/);
  checkLate(db, { now: '08:40', day });
  await settle();
  assert.ok(!take('https://push.example/mgr2').some((x) => x.kind === 'late' && x.body.includes('08:00–16:00')), 'only once');
});

test('new job applications and events enquiries reach whoever looks after them', async () => {
  const { checkCareers } = await import('../src/careers-inbox.js');
  const { checkEvents } = await import('../src/events.js');
  const { memoryMailbox } = await import('../src/mailbox.js');
  const admin = await login('admin@cafe.local');
  await admin('/push/subscribe', { method: 'POST', body: sub('https://push.example/admin') });
  take('');
  const careers = memoryMailbox([{ id: 'cv1', subject: 'Barista job', from: 'ana@example.com', fromName: 'Ana Lopez', receivedAt: new Date().toISOString(), body: 'I would love to work with you.' }], 'careers@cafe.example');
  await checkCareers(db, { mailbox: careers });
  await settle();
  const app = take('https://push.example/admin').find((x) => x.kind === 'application');
  assert.ok(app);
  assert.match(app.body, /Ana Lopez/);
  assert.match(app.page, /people\/recruitment\/candidates\/\d+/);
  const events = memoryMailbox([{ id: 'ev1', subject: 'Birthday party for 30', from: 'sam@example.com', fromName: 'Sam Party', receivedAt: new Date().toISOString(), body: 'Can we book your space?' }], 'events@cafe.example');
  await checkEvents(db, { mailbox: events });
  await settle();
  const enq = take('https://push.example/admin').find((x) => x.kind === 'enquiry');
  assert.ok(enq);
  assert.match(enq.body, /Sam Party/);
});

test('notifications are kept on each person’s Notifications page, and a tap opens it', async () => {
  const staff = await login('staff1@cafe.local');
  await staff('/push/subscribe', { method: 'POST', body: sub('https://push.example/inbox') });
  take('');
  const sentTest = await staff('/push/test', { method: 'POST' });
  assert.ok(sentTest.data.sent >= 1);
  const [msg] = take('https://push.example/inbox');
  const box = (await staff('/notifications')).data;
  assert.ok(box.unread >= 1);
  const kept = box.items[0];
  assert.equal(kept.title, 'Atlas notifications are on');
  assert.equal(kept.read_at, null);
  assert.equal(msg.url, `/#/notifications?n=${kept.id}`, 'tapping opens the Notifications page at that one');
  await staff('/notifications/read', { method: 'POST' });
  assert.equal((await staff('/notifications')).data.unread, 0);
  const other = await login('staff1-2@cafe.local');
  assert.ok(!(await other('/notifications')).data.items.some((n) => n.id === kept.id), 'only your own');
});
