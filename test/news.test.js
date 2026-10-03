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
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer()) };
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

test('news photos and videos: upload, attach, stream in parts, and only reach the people the post is for', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staffHere = await login('staff1@cafe.local');
  const staffThere = await login('staff2@cafe.local');
  const here = manager.me.location_id;
  const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const upload = (who, body) => who('/news/media', { method: 'POST', body });

  assert.equal((await upload(staffHere, { media_type: 'image/png', data: 'aGVsbG8=' })).status, 403, 'staff can’t upload');
  assert.equal((await upload(manager, { media_type: 'application/pdf', data: 'aGVsbG8=' })).status, 400, 'only photos and videos');
  const photo = await upload(manager, { file_name: 'team.jpg', media_type: 'image/jpeg', data: Buffer.from('fake jpeg').toString('base64') });
  const clip = await upload(manager, { file_name: 'clip.mp4', media_type: 'video/mp4', data: video.toString('base64') });
  assert.deepEqual([photo.status, photo.data.kind, clip.data.kind], [201, 'image', 'video']);
  assert.equal((await staffHere(`/news/media/${photo.data.id}`)).status, 404, 'not visible until it’s on a post');

  const post = await manager('/news', { method: 'POST', body: { title: 'Team photo', body: 'Look!', all_sites: false, site_ids: [here], media_ids: [clip.data.id, photo.data.id] } });
  assert.equal(post.status, 201);
  assert.deepEqual(post.data.media.map((m) => m.kind), ['video', 'image'], 'kept in the order given');
  const feed = (await staffHere('/news')).data.find((p) => p.id === post.data.id);
  assert.equal(feed.media.length, 2);

  const whole = await staffHere(`/news/media/${photo.data.id}`);
  assert.deepEqual([whole.status, whole.headers.get('content-type'), whole.data.toString()], [200, 'image/jpeg', 'fake jpeg']);
  const part = await staffHere(`/news/media/${clip.data.id}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual([...part.data], [...video.subarray(100, 200)]);
  const tail = await staffHere(`/news/media/${clip.data.id}`, { headers: { Range: 'bytes=990-' } });
  assert.deepEqual([tail.status, tail.data.length], [206, 10]);
  assert.equal((await staffHere(`/news/media/${clip.data.id}`, { headers: { Range: 'bytes=5000-' } })).status, 416);
  assert.equal((await staffThere(`/news/media/${photo.data.id}`)).status, 404, 'other sites can’t see it');

  // Someone else's upload can't be attached; removing media from a post deletes it; deleting the post removes the rest.
  const theirs = await upload(admin, { media_type: 'image/png', data: 'aGVsbG8=' });
  assert.equal((await manager(`/news/${post.data.id}`, { method: 'PUT', body: { title: 'Team photo', body: 'Look!', all_sites: false, site_ids: [here], media_ids: [theirs.data.id] } })).status, 404);
  assert.equal((await manager(`/news/${post.data.id}`, { method: 'PUT', body: { title: 'Team photo', body: 'Look!', all_sites: false, site_ids: [here], media_ids: [photo.data.id] } })).status, 200);
  assert.equal((await admin(`/news/media/${clip.data.id}`)).status, 404, 'the removed video is gone');
  await manager(`/news/${post.data.id}`, { method: 'DELETE' });
  assert.equal((await admin(`/news/media/${photo.data.id}`)).status, 404, 'deleted with the post');
});
