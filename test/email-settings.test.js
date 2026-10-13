import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { brevoMailer, memoryMailer } from '../src/email.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
const mailer = memoryMailer();
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  db.prepare(`UPDATE users SET email = 'owner@atlas.test' WHERE email = 'admin@cafe.local'`).run();
  server = createApp(db, { mailer }).listen(0);
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

test('Setup → Email: each kind of email comes from its own address, falling back to the default', async () => {
  const admin = await login('owner@atlas.test');
  const start = (await admin('/admin/email-settings')).data;
  assert.equal(start.ready, true);
  assert.equal(start.kinds.find((k) => k.key === 'invites').uses.from, 'reports@brewly.demo', 'the server address until one is set');

  assert.equal((await admin('/admin/email-settings', { method: 'PUT', body: { kinds: { default: { from: 'not an email' } } } })).status, 400);
  const saved = await admin('/admin/email-settings', { method: 'PUT', body: { kinds: {
    default: { from: 'Hello@BrewAndBarrel.co.uk', name: 'Brew & Barrel', reply_to: '' },
    invites: { from: 'people@brewandbarrel.co.uk', name: '', reply_to: 'hr@brewandbarrel.co.uk' },
  } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const invites = saved.data.kinds.find((k) => k.key === 'invites').uses;
  assert.deepEqual(invites, { from: 'people@brewandbarrel.co.uk', name: 'Brew & Barrel', reply_to: 'hr@brewandbarrel.co.uk' });
  assert.equal(saved.data.kinds.find((k) => k.key === 'reports').uses.from, 'hello@brewandbarrel.co.uk', 'blank uses the default');

  // A password reset goes out from the invites address, with replies to HR.
  const staff = db.prepare(`SELECT email FROM users WHERE email = 'staff1@cafe.local'`).get();
  await fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'atlas.test' }, body: JSON.stringify({ email: staff.email }) });
  const reset = mailer.sent.at(-1);
  assert.equal(reset?.to, staff.email, 'a reset email was sent');
  assert.equal(reset.from, 'people@brewandbarrel.co.uk');
  assert.equal(reset.replyTo, 'hr@brewandbarrel.co.uk');

  // A test email of each kind, to the person signed in.
  const t = await admin('/admin/email-settings/test', { method: 'POST', body: { kind: 'reports' } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const sent = mailer.sent.at(-1);
  assert.equal(sent.to, 'owner@atlas.test');
  assert.equal(sent.from, 'hello@brewandbarrel.co.uk');
  assert.equal(sent.fromName, 'Brew & Barrel');

  // Only admins.
  const manager = await login('manager1@cafe.local');
  assert.equal((await manager('/admin/email-settings')).status, 403);
});

test('Brevo is sent the chosen sender and reply-to', async () => {
  const calls = [];
  const m = brevoMailer({ apiKey: 'k', from: 'server@x.test', fromName: 'Atlas' }, async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true }; });
  await m.send({ to: 'a@b.test', subject: 's', text: 't', html: 'h' });
  await m.send({ to: 'a@b.test', subject: 's', text: 't', html: 'h', from: 'people@x.test', fromName: 'People', replyTo: 'hr@x.test' });
  assert.deepEqual(calls[0].sender, { email: 'server@x.test', name: 'Atlas' });
  assert.equal(calls[0].replyTo, undefined);
  assert.deepEqual(calls[1].sender, { email: 'people@x.test', name: 'People' });
  assert.deepEqual(calls[1].replyTo, { email: 'hr@x.test' });
});
