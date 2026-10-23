import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { deviceOf, describe } from '../src/activity.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { today } from '../src/util.js';

let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email, password = DEMO_PASSWORD) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
}
const log = () => db.prepare('SELECT * FROM activity_log ORDER BY id').all();

test('devices are described in plain words', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), 'Windows · Edge');
  assert.equal(deviceOf(''), null);
});

test('every change route has words, and background saves are left out', () => {
  assert.equal(describe(db, 'POST', '/rota/publish', {}).action, 'Published the rota');
  assert.equal(describe(db, 'POST', '/leave/5/decide', { status: 'approved' }).action, 'Approved holiday');
  assert.equal(describe(db, 'POST', '/push/subscribe', {}), null);
  assert.equal(describe(db, 'POST', '/events/inbox/check', {}), null);
  assert.equal(describe(db, 'POST', '/something-new', {}).action, 'Saved something new');
});

test('sign-ins, failed sign-ins and changes are logged, and only admins can see the log', async () => {
  const before = log().length;
  await login('staff1@cafe.local', 'wrong-password');
  await login('nobody@cafe.local', 'whatever');
  const s = await login('staff1@cafe.local');
  const staff = db.prepare(`SELECT id, name FROM users WHERE email = 'staff1@cafe.local'`).get();
  const rows = log().slice(before);
  assert.deepEqual(rows.map((r) => r.kind), ['sign_in_failed', 'sign_in_failed', 'sign_in']);
  assert.equal(rows[0].user_id, staff.id);
  assert.equal(rows[0].detail, 'Wrong password');
  assert.match(rows[1].detail, /nobody@cafe\.local/);
  assert.equal(rows[2].device, 'iPhone · Safari');
  assert.ok(!rows.some((r) => /wrong-password|whatever/.test(JSON.stringify(r))), 'passwords are never logged');

  // A change, named before it happens; a failed one isn't logged.
  const shift = db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY date LIMIT 1').get(staff.id);
  const m = await login('manager1@cafe.local');
  assert.equal((await m(`/shifts/${shift.id}`, { method: 'DELETE' })).status, 200);
  const del = log().at(-1);
  assert.equal(del.action, 'Deleted a shift');
  assert.match(del.detail, new RegExp(staff.name));
  const n = log().length;
  assert.equal((await m('/leave/999999/decide', { method: 'POST', body: { status: 'approved' } })).status, 404);
  assert.equal(log().length, n);

  // Staff and managers can't see it; admins can, filtered.
  assert.equal((await s('/staff-log')).status, 403);
  assert.equal((await m('/staff-log')).status, 403);
  const a = await login('admin@cafe.local');
  const all = (await a(`/staff-log?from=${today()}&to=${today()}`)).data;
  assert.ok(all.rows.some((r) => r.action === 'Deleted a shift' && r.user_name.includes('Manager')));
  const signIns = (await a(`/staff-log?kind=sign_ins&user_id=${staff.id}`)).data.rows;
  assert.ok(signIns.length >= 2 && signIns.every((r) => r.user_id === staff.id && r.kind !== 'change'));
  assert.ok(signIns.some((r) => r.action === 'Failed sign-in'));
});

test('the same change again within a few minutes is one entry with a count', async () => {
  const s = await login('staff1@cafe.local');
  const post = db.prepare(`SELECT id FROM news_posts ORDER BY id LIMIT 1`).get();
  await s(`/news/${post.id}/read`, { method: 'POST' });
  await s(`/news/${post.id}/read`, { method: 'POST' });
  const last = log().at(-1);
  assert.equal(last.action, 'Confirmed they’d read a news post');
  assert.equal(last.times, 2);
});

test('signing out and changing a password are logged', async () => {
  const s = await login('staff1-2@cafe.local');
  await s('/auth/password', { method: 'POST', body: { current_password: DEMO_PASSWORD, new_password: 'a-new-password-1' } });
  await s('/auth/logout', { method: 'POST' });
  assert.deepEqual(log().slice(-2).map((r) => r.kind), ['password', 'sign_out']);
});
