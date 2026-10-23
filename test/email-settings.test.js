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

  // A service that isn't set up can't be chosen.
  assert.equal((await admin('/admin/email-settings', { method: 'PUT', body: { provider: 'microsoft', kinds: {} } })).status, 400);

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

test('Microsoft 365: sends as the chosen mailbox through Graph, with reply-to, saved to Sent Items', async () => {
  const { graphMailer } = await import('../src/mailbox.js');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('login.microsoftonline.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (url.includes('nobody%40')) return { ok: false, status: 404, json: async () => ({ error: { message: 'Resource not found' } }) };
    if (url.includes('blocked%40')) return { ok: false, status: 403, json: async () => ({ error: { message: 'Access is denied' } }) };
    return { ok: true, status: 202, json: async () => ({}) };
  };
  const m = graphMailer({ tenant: 't', clientId: 'c', secret: 's', from: null }, fetchFn);
  await m.send({ to: 'a@b.test', name: 'Ann', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', from: 'people@x.test', replyTo: 'hr@x.test' });
  const send = calls.find((c) => c.url.endsWith('/sendMail'));
  assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/people%40x.test/sendMail');
  assert.equal(send.init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(send.init.body);
  assert.equal(body.saveToSentItems, true);
  assert.deepEqual(body.message.body, { contentType: 'HTML', content: '<p>Hi</p>' });
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'a@b.test', name: 'Ann' } }]);
  assert.deepEqual(body.message.replyTo, [{ emailAddress: { address: 'hr@x.test' } }]);
  // One sign-in is reused.
  await m.send({ to: 'a@b.test', subject: 'Again', text: 'x', from: 'people@x.test' });
  assert.equal(calls.filter((c) => c.url.includes('login.microsoftonline.com')).length, 1);

  await assert.rejects(m.send({ to: 'a@b.test', subject: 's', text: 't' }), /Choose a “Send from” mailbox/);
  await assert.rejects(m.send({ to: 'a@b.test', subject: 's', text: 't', from: 'nobody@x.test' }), (e) => e.senderProblem && /no mailbox nobody@x.test/.test(e.message));
  await assert.rejects(m.send({ to: 'a@b.test', subject: 's', text: 't', from: 'blocked@x.test' }), (e) => e.senderProblem && /Mail.Send/.test(e.message));
});

test('Setup → Email switches between Brevo and Microsoft 365 when both are set up', async () => {
  const { withSenders } = await import('../src/email.js');
  const d = openDb(':memory:');
  seedAdmin(d, { email: 'boss@atlas.test', password: DEMO_PASSWORD });
  const brevo = memoryMailer();
  const microsoft = { ...memoryMailer(), sent: [], from: null };
  microsoft.send = async (e) => { microsoft.sent.push(e); };
  const app = createApp(d, { mailer: withSenders(d, { brevo, microsoft }) }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const url = `http://127.0.0.1:${app.address().port}/api`;
  try {
    const res = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@atlas.test', password: DEMO_PASSWORD }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (path, method = 'GET', body) => { const r = await fetch(`${url}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
    const first = (await call('/admin/email-settings')).data;
    assert.equal(first.provider, 'brevo');
    assert.deepEqual(first.providers.map((p) => [p.key, p.ready]), [['brevo', true], ['microsoft', true]]);
    const sw = await call('/admin/email-settings', 'PUT', { provider: 'microsoft', kinds: { default: { from: 'hello@x.test' } } });
    assert.equal(sw.data.provider, 'microsoft');
    const t = await call('/admin/email-settings/test', 'POST', { kind: 'invites' });
    assert.equal(t.data.provider, 'Microsoft 365');
    assert.equal(microsoft.sent.at(-1).from, 'hello@x.test');
    assert.equal(brevo.sent.length, 0);
  } finally { app.close(); }

  // Only what's set up can be chosen.
  const only = withSenders(openDb(':memory:'), { brevo: memoryMailer(), microsoft: null });
  assert.deepEqual(only.available, ['brevo']);
});
