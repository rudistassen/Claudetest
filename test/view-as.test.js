import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

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

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
}
const user = (email) => db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);

test('an admin sees Atlas as a member of staff would, and can’t change anything while they do', async () => {
  const a = await login('admin@cafe.local');
  const staff = user('staff1@cafe.local');
  assert.equal((await a('/auth/view-as', { method: 'POST', body: { user_id: staff.id } })).status, 200);

  const me = (await a('/auth/me')).data.user;
  assert.equal(me.id, staff.id);
  assert.equal(me.role, 'staff');
  assert.equal(me.viewed_by, 'Owner');
  // Their access, not the admin's.
  assert.equal((await a('/staff-log')).status, 403);
  assert.equal((await a('/users')).status, 403);
  const shifts = (await a('/my-shifts')).data;
  assert.ok(shifts.length && shifts.every((s) => s.user_id === undefined || s.user_id === staff.id));

  // Look only.
  const post = db.prepare('SELECT id FROM news_posts ORDER BY id LIMIT 1').get();
  const r = await a(`/news/${post.id}/read`, { method: 'POST' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /viewing Atlas as/);
  assert.ok(!db.prepare('SELECT 1 FROM news_reads WHERE post_id = ? AND user_id = ?').get(post.id, staff.id));
  assert.equal((await a('/leave', { method: 'POST', body: { start_date: '2099-01-01', end_date: '2099-01-02' } })).status, 403);
  assert.equal((await a('/auth/password', { method: 'POST', body: { current_password: 'x', new_password: 'yyyyyyyy' } })).status, 403);
  // Opening pages doesn't throw errors.
  assert.equal((await a('/notifications/read', { method: 'POST' })).status, 200);

  // Stopping puts them back.
  assert.equal((await a('/auth/view-as/stop', { method: 'POST' })).status, 200);
  const back = (await a('/auth/me')).data.user;
  assert.equal(back.role, 'admin');
  assert.equal(back.viewed_by, undefined);
  assert.equal((await a('/staff-log')).status, 200);
  const logged = db.prepare(`SELECT action, detail FROM activity_log WHERE action LIKE '%viewing Atlas%' ORDER BY id`).all();
  assert.deepEqual(logged.map((l) => [l.action, l.detail]), [['Started viewing Atlas as someone', staff.name], ['Stopped viewing Atlas as someone', staff.name]]);
});

test('only admins can view as someone (another admin too, but not themselves or someone switched off)', async () => {
  const m = await login('manager1@cafe.local');
  assert.equal((await m('/auth/view-as', { method: 'POST', body: { user_id: user('staff1@cafe.local').id } })).status, 403);
  const a = await login('admin@cafe.local');
  assert.equal((await a('/auth/view-as', { method: 'POST', body: { user_id: user('admin@cafe.local').id } })).status, 400);
  // Another admin: they see it as that admin, still look only.
  const other = db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES ('Second Admin', 'admin2@cafe.local', 'x', 'admin')`).run().lastInsertRowid;
  assert.equal((await a('/auth/view-as', { method: 'POST', body: { user_id: Number(other) } })).status, 200);
  const me = (await a('/auth/me')).data.user;
  assert.deepEqual([me.name, me.role, me.viewed_by], ['Second Admin', 'admin', 'Owner']);
  assert.equal((await a('/locations', { method: 'POST', body: { name: 'Nope' } })).status, 403);
  await a('/auth/view-as/stop', { method: 'POST' });
  assert.equal((await a('/auth/me')).data.user.name, 'Owner');
  const off = user('staff1-3@cafe.local');
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(off.id);
  try {
    assert.equal((await a('/auth/view-as', { method: 'POST', body: { user_id: off.id } })).status, 404);
  } finally {
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(off.id);
  }
  // Viewing only affects that sign-in: the person's own session is untouched.
  const s = await login('staff1@cafe.local');
  await a('/auth/view-as', { method: 'POST', body: { user_id: user('staff1@cafe.local').id } });
  assert.equal((await s('/auth/me')).data.user.viewed_by, undefined);
  const post = db.prepare('SELECT id FROM news_posts ORDER BY id LIMIT 1').get();
  assert.equal((await s(`/news/${post.id}/read`, { method: 'POST' })).status, 200);
  await a('/auth/view-as/stop', { method: 'POST' });
});
