import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { brevoMailer, emailConfig, memoryMailer } from '../src/email.js';
import { dayOfWeek } from '../src/metrics.js';
import { runDueReports } from '../src/reports.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

let server;
let base;
let db;
const mailer = memoryMailer();

before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { mailer }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

const quiet = { log() {}, error() {} };

test('email reports: admins set them up, each person gets their own sites, and they send once a day when due', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  assert.equal((await manager('/reports/email')).status, 403, 'admins only');

  const setup = (await admin('/reports/email')).data;
  assert.equal(setup.ready, true);
  const ids = [manager.me.id, staff.me.id];
  assert.ok(ids.every((i) => setup.people.some((p) => p.id === i)));

  const good = { name: 'Morning report', send_time: '23:59', days: [0, 1, 2, 3, 4, 5, 6], period: 'yesterday', recipient_ids: ids };
  assert.equal((await admin('/reports/email', { method: 'POST', body: { ...good, recipient_ids: [] } })).status, 400);
  assert.equal((await admin('/reports/email', { method: 'POST', body: { ...good, days: [] } })).status, 400);
  assert.equal((await admin('/reports/email', { method: 'POST', body: { ...good, send_time: '25:00' } })).status, 400);
  const created = await admin('/reports/email', { method: 'POST', body: good });
  assert.equal(created.status, 201);
  const s = created.data;
  assert.deepEqual(s.recipients.map((r) => r.id).sort(), [...ids].sort());

  // The preview shows what each person gets: a manager their own site with sales; staff no sales figures.
  const forManager = (await admin(`/reports/email/${s.id}/preview?user_id=${manager.me.id}`)).data;
  const home = db.prepare('SELECT name FROM locations WHERE id = ?').get(manager.me.location_id).name;
  assert.match(forManager.html, new RegExp(home));
  assert.match(forManager.html, /Net sales|Net <strong>/);
  const others = db.prepare('SELECT name FROM locations WHERE id != ? AND active = 1').all(manager.me.location_id);
  if (!manager.me.all_sites) assert.ok(others.every((l) => !forManager.html.includes(`>${l.name}<`)), 'only their sites');
  const forStaff = (await admin(`/reports/email/${s.id}/preview?user_id=${staff.me.id}`)).data;
  assert.doesNotMatch(forStaff.html, /Gross sales|Net <strong>/, 'no sales figures without sales.view');
  assert.match(forManager.subject, /Morning report/);

  // Send me a test: just to the admin.
  mailer.sent.length = 0;
  const test1 = await admin(`/reports/email/${s.id}/send`, { method: 'POST', body: { to: 'me' } });
  assert.deepEqual([test1.status, test1.data.sent, mailer.sent[0]?.to], [200, 1, 'admin@cafe.local']);

  // The scheduler: due once its time has passed on one of its days, then not again that day.
  db.prepare('UPDATE report_schedules SET send_time = ?, last_sent_date = NULL').run('07:00');
  const d = today();
  mailer.sent.length = 0;
  assert.equal((await runDueReports(db, mailer, { log: quiet, now: { date: d, minutes: 6 * 60 + 59 } })).length, 0, 'not yet');
  let synced = 0;
  const r = await runDueReports(db, mailer, { log: quiet, now: { date: d, minutes: 7 * 60 + 1 }, beforeSend: async () => { synced++; } });
  assert.deepEqual([r.length, r[0].sent, synced, mailer.sent.length], [1, 2, 1, 2]);
  assert.deepEqual(mailer.sent.map((m) => m.to).sort(), [manager.me.email, staff.me.email].sort());
  assert.equal((await runDueReports(db, mailer, { log: quiet, now: { date: d, minutes: 9 * 60 } })).length, 0, 'only once a day');
  assert.match(db.prepare('SELECT last_result FROM report_schedules WHERE id = ?').get(s.id).last_result, /sent to 2 people/);

  // Only on its days, and not while switched off.
  const tomorrow = addDays(d, 1);
  await admin(`/reports/email/${s.id}`, { method: 'PUT', body: { ...good, send_time: '07:00', days: [(dayOfWeek(tomorrow) + 1) % 7] } });
  assert.equal((await runDueReports(db, mailer, { log: quiet, now: { date: tomorrow, minutes: 8 * 60 } })).length, 0, 'not one of its days');
  await admin(`/reports/email/${s.id}`, { method: 'PUT', body: { ...good, send_time: '07:00', active: false } });
  assert.equal((await runDueReports(db, mailer, { log: quiet, now: { date: tomorrow, minutes: 8 * 60 } })).length, 0, 'switched off');

  assert.equal((await admin(`/reports/email/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin('/reports/email')).data.schedules.length, 0);
});

test('Brevo mailer sends through the web API and explains refusals', async () => {
  assert.equal(emailConfig({}), null);
  const config = emailConfig({ BREVO_API_KEY: ' "key-123" ', EMAIL_FROM: 'reports@cafe.co.uk' });
  assert.deepEqual(config, { apiKey: 'key-123', from: 'reports@cafe.co.uk', fromName: 'Atlas' });
  const calls = [];
  const ok = brevoMailer(config, async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 201 }); });
  await ok.send({ to: 'sam@cafe.co.uk', name: 'Sam', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'key-123');
  assert.deepEqual(JSON.parse(calls[0].init.body).to, [{ email: 'sam@cafe.co.uk', name: 'Sam' }]);
  const refused = brevoMailer(config, async () => new Response(JSON.stringify({ message: 'Key not found' }), { status: 401 }));
  await assert.rejects(refused.send({ to: 'x@y.z', subject: 's', html: 'h', text: 't' }), /401.*BREVO_API_KEY/);
});
