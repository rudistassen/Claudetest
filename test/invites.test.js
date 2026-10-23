import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { memoryMailer } from '../src/email.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
const mailer = memoryMailer();

before(async () => {
  process.env.APP_URL = 'https://brewly.example.co.uk/';
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { mailer }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); delete process.env.APP_URL; });

function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  call.login = async (email, password = DEMO_PASSWORD) => (await call('/auth/login', { method: 'POST', body: { email, password } }));
  return call;
}
const tokenFrom = (email) => email.text.match(/token=([\w-]+)/)[1];

test('staff added without a password are invited, choose their own password and show as joined', async () => {
  const manager = client();
  await manager.login('manager1@cafe.local');
  const me = (await manager('/auth/me')).data.user;
  const created = await manager('/users', { method: 'POST', body: { name: 'Nina Newstarter', email: 'nina@brewly-test.co.uk', location_id: me.location_id, role: 'staff' } });
  assert.equal(created.status, 201, 'a password is no longer needed');
  const nina = created.data;
  assert.equal(nina.invited_at, null);

  // Managers can't invite admins or staff at other sites.
  const adminId = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get().id;
  assert.equal((await manager('/users/invite', { method: 'POST', body: { ids: [adminId] } })).status, 403);
  const elsewhere = db.prepare('SELECT id FROM users WHERE location_id != ? AND role = ? LIMIT 1').get(me.location_id, 'staff').id;
  if (!me.all_sites) assert.equal((await manager('/users/invite', { method: 'POST', body: { ids: [elsewhere] } })).status, 403);

  const sent = await manager('/users/invite', { method: 'POST', body: { ids: [nina.id] } });
  assert.deepEqual(sent.data.sent.map((s) => s.name), ['Nina Newstarter']);
  const email = mailer.sent.at(-1);
  assert.equal(email.to, 'nina@brewly-test.co.uk');
  assert.match(email.text, /^[\s\S]*https:\/\/brewly\.example\.co\.uk\/#\/set-password\?token=/);
  assert.match(email.html, /Choose your password/);

  let row = (await manager('/users')).data.find((u) => u.id === nina.id);
  assert.ok(row.invited_at);
  assert.equal(row.last_login_at, null);

  const token = tokenFrom(email);
  const guest = client();
  assert.deepEqual((await guest(`/auth/token?token=${token}`)).data, { purpose: 'invite', name: 'Nina Newstarter', email: 'nina@brewly-test.co.uk' });
  assert.equal((await guest('/auth/token', { method: 'POST', body: { token, password: 'short' } })).status, 400);
  const joined = await guest('/auth/token', { method: 'POST', body: { token, password: 'my own secret' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.user.name, 'Nina Newstarter');
  assert.equal((await guest('/auth/me')).status, 200, 'signed in straight away');
  assert.equal((await guest('/auth/token', { method: 'POST', body: { token, password: 'another one!' } })).status, 404, 'a link only works once');
  assert.equal((await client().login('nina@brewly-test.co.uk', 'my own secret')).status, 200);

  row = (await manager('/users')).data.find((u) => u.id === nina.id);
  assert.ok(row.last_login_at, 'shows as joined');
});

test('a copied invite link works like an emailed one, and a newer invite replaces the old link', async () => {
  const admin = client();
  await admin.login('admin@cafe.local');
  const person = db.prepare(`SELECT id FROM users WHERE email = 'staff3@cafe.local'`).get();
  const first = (await admin('/users/invite', { method: 'POST', body: { ids: [person.id], link_only: true } })).data.link;
  const second = (await admin('/users/invite', { method: 'POST', body: { ids: [person.id], link_only: true } })).data.link;
  assert.match(second, /^https:\/\/brewly\.example\.co\.uk\/#\/set-password\?token=/);
  const guest = client();
  assert.equal((await guest(`/auth/token?token=${first.split('token=')[1]}`)).status, 404);
  assert.equal((await guest(`/auth/token?token=${second.split('token=')[1]}`)).status, 200);

  // Emailing skips made-up addresses such as the demo's.
  const r = await admin('/users/invite', { method: 'POST', body: { ids: [person.id] } });
  assert.deepEqual(r.data.skipped.map((s) => s.reason), ['no real email address']);
  assert.equal((await client()('/users/invite', { method: 'POST', body: { ids: [person.id] } })).status, 401);
});

test('forgot password emails a 2-hour link without saying whether the email has an account', async () => {
  db.prepare(`UPDATE users SET email = 'sam@brewly-test.co.uk' WHERE email = 'staff2@cafe.local'`).run();
  const guest = client();
  const before = mailer.sent.length;
  const known = await guest('/auth/forgot', { method: 'POST', body: { email: 'SAM@brewly-test.co.uk' } });
  const unknown = await guest('/auth/forgot', { method: 'POST', body: { email: 'nobody@brewly-test.co.uk' } });
  assert.deepEqual(known.data, unknown.data);
  assert.equal(mailer.sent.length, before + 1);
  const email = mailer.sent.at(-1);
  assert.equal(email.subject, 'Reset your Atlas password');
  const token = tokenFrom(email);
  assert.equal((await guest(`/auth/token?token=${token}`)).data.purpose, 'reset');

  // Their other devices are signed out when the password changes.
  const phone = client();
  await phone.login('sam@brewly-test.co.uk', DEMO_PASSWORD);
  assert.equal((await phone('/auth/me')).status, 200);
  assert.equal((await guest('/auth/token', { method: 'POST', body: { token, password: 'brand new pass' } })).status, 200);
  assert.equal((await phone('/auth/me')).status, 401);

  // Expired links don't work.
  await guest('/auth/forgot', { method: 'POST', body: { email: 'sam@brewly-test.co.uk' } });
  const late = tokenFrom(mailer.sent.at(-1));
  db.prepare(`UPDATE password_tokens SET expires_at = datetime('now', '-1 minute') WHERE purpose = 'reset' AND used_at IS NULL`).run();
  assert.equal((await guest(`/auth/token?token=${late}`)).status, 404);

  // Only a few requests an hour for one email.
  for (let i = 0; i < 4; i++) await guest('/auth/forgot', { method: 'POST', body: { email: 'sam@brewly-test.co.uk' } });
  assert.ok(mailer.sent.length <= before + 3);
});
