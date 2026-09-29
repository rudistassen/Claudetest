import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

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


test('My Brew news: who sees what, who can post where, and confirming you have read it', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local'); // one site
  const staffHere = await login('staff1@cafe.local'); // same site as manager1
  const staffThere = await login('staff2@cafe.local'); // another site
  const here = manager.me.location_id;
  const titles = async (who) => (await who('/news')).data.map((p) => p.title);

  assert.equal((await staffHere('/news/manage')).status, 403, 'staff can’t manage news');
  assert.equal((await staffHere('/news', { method: 'POST', body: { title: 'x', body: 'y' } })).status, 403);
  assert.equal((await manager('/news', { method: 'POST', body: { title: 'Everyone', body: 'x', all_sites: true } })).status, 403, 'a one-site manager can’t post to every site');
  assert.equal((await manager('/news', { method: 'POST', body: { title: 'Nowhere', body: 'x', all_sites: false, site_ids: [] } })).status, 400);

  const local = await manager('/news', { method: 'POST', body: { title: 'Our new till', body: 'See the guide', category: 'policy', requires_ack: true, all_sites: false, site_ids: [here] } });
  assert.equal(local.status, 201);
  const everyone = await admin('/news', { method: 'POST', body: { title: 'Staff party', body: 'Friday!', category: 'event', pinned: true } });
  assert.equal(everyone.status, 201);

  assert.ok((await titles(staffHere)).includes('Our new till'));
  assert.ok(!(await titles(staffThere)).includes('Our new till'), 'other sites don’t see it');
  assert.equal((await titles(staffThere))[0], 'Staff party', 'pinned posts come first');

  // Confirming it's been read.
  const before = (await staffHere('/news/unread')).data.count;
  assert.ok(before >= 1);
  assert.equal((await staffHere(`/news/${local.data.id}/read`, { method: 'POST' })).status, 200);
  assert.equal((await staffHere('/news/unread')).data.count, before - 1);
  assert.equal((await staffThere(`/news/${local.data.id}/read`, { method: 'POST' })).status, 404, 'can’t read a post not meant for you');
  const reads = (await manager(`/news/${local.data.id}/reads`)).data;
  assert.ok(reads.find((r) => r.id === staffHere.me.id).read_at);
  assert.ok(!reads.some((r) => r.id === staffThere.me.id), 'only the post’s sites are counted');

  // Editing: managers can’t touch posts for every site; "ask again" clears who has read it.
  assert.equal((await manager(`/news/${everyone.data.id}`, { method: 'PUT', body: { title: 'x', body: 'y' } })).status, 403);
  const edited = await manager(`/news/${local.data.id}`, { method: 'PUT', body: { title: 'Our new till (v2)', body: 'Updated', category: 'policy', requires_ack: true, all_sites: false, site_ids: [here], ask_again: true } });
  assert.equal(edited.status, 200);
  assert.equal((await staffHere('/news/unread')).data.count, before, 'needs reading again');
  assert.equal((await manager(`/news/${local.data.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await titles(staffHere)).includes('Our new till (v2)'));
});
