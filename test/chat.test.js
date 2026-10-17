import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEFAULT_SETS } from '../src/permissions.js';
import { setPushSender } from '../src/push.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
const pushed = [];
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  setPushSender(async (sub, payload) => { pushed.push(JSON.parse(payload)); });
});
after(() => { setPushSender(null); server.close(); });

const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('chat permissions: everyone can chat, managers can start chats', () => {
  assert.ok(DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions.includes('chat.use'));
  assert.ok(!DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions.includes('chat.manage'));
  const manager = DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions;
  assert.ok(manager.includes('chat.use') && manager.includes('chat.manage'));
});

test('a manager starts a chat; only the people in it can see it, read it and reply', async () => {
  const manager = await login('manager1@cafe.local');
  const staff1 = await login('staff1@cafe.local');
  const staff2 = await login('staff2@cafe.local');
  const site1 = db.prepare('SELECT location_id FROM users WHERE email = ?').get('manager1@cafe.local').location_id;

  // Staff can't start chats.
  assert.equal((await staff1('/chat', { method: 'POST', body: { name: 'Mine', member_ids: [userId('staff2@cafe.local')] } })).status, 403);

  // Everyone at site 1, plus one person from site 2 by name.
  const made = await manager('/chat', { method: 'POST', body: { name: 'Site 1 team', site_ids: [site1], member_ids: [userId('staff2-2@cafe.local')] } });
  assert.equal(made.status, 201);
  const chatId = made.body.id;

  assert.ok((await staff1('/chat')).body.groups.some((g) => g.id === chatId));
  assert.ok(!(await staff2('/chat')).body.groups.some((g) => g.id === chatId));
  assert.equal((await staff2(`/chat/${chatId}`)).status, 404);
  assert.equal((await staff2(`/chat/${chatId}/messages`, { method: 'POST', body: { body: 'Hi' } })).status, 404);
  const named = await login('staff2-2@cafe.local');
  assert.ok((await named('/chat')).body.groups.some((g) => g.id === chatId));

  // A message notifies the others (not the sender), straight to the chat, and isn't kept on the Notifications page.
  pushed.length = 0;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/s1', 'k', 'a')`).run(userId('staff1@cafe.local'));
  const sent = await manager(`/chat/${chatId}/messages`, { method: 'POST', body: { body: 'Delivery is late today' } });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.mine);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].url, `/#/chat/${chatId}`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'chat'`).get().n, 0);

  // Unread until read; replies show up for the others.
  assert.equal((await staff1('/chat/unread')).body.count, 1);
  const seen = await staff1(`/chat/${chatId}`);
  assert.equal(seen.body.messages.at(-1).body, 'Delivery is late today');
  assert.equal(seen.body.messages.at(-1).can_delete, false);
  await staff1(`/chat/${chatId}/read`, { method: 'POST', body: { last_id: sent.body.id } });
  assert.equal((await staff1('/chat/unread')).body.count, 0);
  const reply = await staff1(`/chat/${chatId}/messages`, { method: 'POST', body: { body: 'Thanks, I’ll let the kitchen know' } });
  assert.equal(reply.status, 201);
  const newer = await manager(`/chat/${chatId}?after=${sent.body.id}`);
  assert.deepEqual(newer.body.messages.map((m) => m.body), ['Thanks, I’ll let the kitchen know']);
  assert.equal((await manager('/chat/unread')).body.count, 1);

  // Muted chats don't count towards the badge or send notifications.
  await manager(`/chat/${chatId}/mute`, { method: 'POST', body: { muted: true } });
  assert.equal((await manager('/chat/unread')).body.count, 0);

  // People delete their own messages; the person who set the chat up can delete anyone's.
  assert.equal((await staff1(`/chat/${chatId}/messages/${sent.body.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await manager(`/chat/${chatId}/messages/${reply.body.id}`, { method: 'DELETE' })).status, 200);
  const after = await staff1(`/chat/${chatId}`);
  const gone = after.body.messages.find((m) => m.id === reply.body.id);
  assert.ok(gone.deleted_at);
  assert.equal(gone.body, '');

  // An empty message is refused.
  assert.equal((await staff1(`/chat/${chatId}/messages`, { method: 'POST', body: { body: '  ' } })).status, 400);
});

test('photos are sent with a message and only people in the chat can open them', async () => {
  const manager = await login('manager1@cafe.local');
  const staff2 = await login('staff2@cafe.local');
  const chatId = (await manager('/chat', { method: 'POST', body: { name: 'Photos', member_ids: [userId('staff1@cafe.local')] } })).body.id;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const sent = await manager(`/chat/${chatId}/messages`, { method: 'POST', body: { photo: { file_name: 'x.png', media_type: 'image/png', data: png.toString('base64') } } });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.has_photo);
  const staff1 = await login('staff1@cafe.local');
  const list = await staff1('/chat');
  assert.equal(list.body.groups.find((g) => g.id === chatId).last.body, '📷 Photo');
  assert.equal((await staff2(`/chat/${chatId}/photos/${sent.body.id}`)).status, 404);
  const loginRes = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff1@cafe.local', password: DEMO_PASSWORD }) });
  const photo = await fetch(`${base}/chat/${chatId}/photos/${sent.body.id}`, { headers: { cookie: loginRes.headers.get('set-cookie').split(';')[0] } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await photo.arrayBuffer()).length, png.length);
  assert.equal((await manager(`/chat/${chatId}/messages`, { method: 'POST', body: { photo: { media_type: 'application/pdf', data: 'AAAA' } } })).status, 400);
});

test('only whoever set a chat up (or an admin) can change it; without chat.use there is no chat', async () => {
  const manager1 = await login('manager1@cafe.local');
  const manager2 = await login('manager2@cafe.local');
  const admin = await login('admin@cafe.local');
  const chatId = (await manager1('/chat', { method: 'POST', body: { name: 'Managers', member_ids: [userId('manager2@cafe.local')] } })).body.id;
  // manager2 is in it and can set chats up, so can change it; a staff member can't.
  assert.equal((await manager2(`/chat/${chatId}`, { method: 'PUT', body: { name: 'Managers 2', member_ids: [userId('manager1@cafe.local'), userId('manager2@cafe.local')] } })).status, 200);
  const staff1 = await login('staff1@cafe.local');
  assert.equal((await staff1(`/chat/${chatId}`, { method: 'PUT', body: { name: 'x', member_ids: [] } })).status, 403);
  // A chat needs someone else in it.
  assert.equal((await manager1('/chat', { method: 'POST', body: { name: 'Just me', member_ids: [] } })).status, 400);
  assert.equal((await admin(`/chat-setup/${chatId}`)).status, 200);
  assert.equal((await admin(`/chat/${chatId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await manager1(`/chat/${chatId}`)).status, 404);

  const person = userId('staff3@cafe.local');
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['rota.view']), person);
  const noChat = await login('staff3@cafe.local');
  assert.deepEqual((await noChat('/chat')).body.groups, []);
  assert.equal((await noChat('/chat/unread')).body.count, 0);
});

test('upgrading gives everyone chat and direct messages, and chat set-up to people who post news or manage staff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-chat-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Leads', '', '["staff.manage"]'), ('Floor', '', '["rota.view"]')`).run();
    d.exec('PRAGMA user_version = 19');
    d.close();
    d = openDb(file);
    const perms = (name) => JSON.parse(d.prepare('SELECT permissions FROM permission_sets WHERE name = ?').get(name).permissions);
    assert.ok(perms('Leads').includes('chat.use') && perms('Leads').includes('chat.manage'));
    assert.ok(perms('Floor').includes('chat.use') && !perms('Floor').includes('chat.manage'));
    assert.ok(perms('Floor').includes('chat.direct') && perms('Leads').includes('chat.direct'));
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct messages: one-to-one with people at your own sites, private to the two of you (and admins)', async () => {
  const staff1 = await login('staff1@cafe.local');
  const staff12 = await login('staff1-2@cafe.local');
  const staff13 = await login('staff1-3@cafe.local');
  const admin = await login('admin@cafe.local');
  const people = (await staff1('/chat/direct/people')).body;
  // Only people at their own site (everyone in the demo can work at every site, but that doesn't count here).
  assert.ok(people.some((u) => u.id === userId('staff1-2@cafe.local')));
  assert.ok(!people.some((u) => u.id === userId('staff2@cafe.local')));
  assert.ok(!people.some((u) => u.id === userId('staff1@cafe.local')));
  assert.equal((await staff1('/chat/direct', { method: 'POST', body: { user_id: userId('staff2@cafe.local') } })).status, 403);

  const dm = await staff1('/chat/direct', { method: 'POST', body: { user_id: userId('staff1-2@cafe.local') } });
  assert.equal(dm.status, 201);
  // Opening it again (from either side) gives the same conversation.
  assert.equal((await staff1('/chat/direct', { method: 'POST', body: { user_id: userId('staff1-2@cafe.local') } })).body.id, dm.body.id);
  assert.equal((await staff12('/chat/direct', { method: 'POST', body: { user_id: userId('staff1@cafe.local') } })).body.id, dm.body.id);

  pushed.length = 0;
  db.prepare(`INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/s12', 'k', 'a')`).run(userId('staff1-2@cafe.local'));
  assert.equal((await staff1(`/chat/${dm.body.id}/messages`, { method: 'POST', body: { body: 'Can you swap Friday?' } })).status, 201);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushed.at(-1).title, db.prepare('SELECT name FROM users WHERE email = ?').get('staff1@cafe.local').name);

  // Each sees it under the other's name; nobody else can open it, and it can't be edited like a group.
  const name = (email) => db.prepare('SELECT name FROM users WHERE email = ?').get(email).name;
  const theirs = (await staff12('/chat')).body.groups.find((g) => g.id === dm.body.id);
  assert.equal(theirs.kind, 'direct');
  assert.equal(theirs.name, name('staff1@cafe.local'));
  assert.equal((await staff1(`/chat/${dm.body.id}`)).body.group.name, name('staff1-2@cafe.local'));
  assert.equal((await staff13(`/chat/${dm.body.id}`)).status, 404);
  assert.equal((await admin(`/chat/${dm.body.id}`)).status, 404);
  assert.equal((await admin(`/chat/${dm.body.id}`, { method: 'PUT', body: { name: 'x', member_ids: [1, 2] } })).status, 403);

  // Admins can read it on Setup → Direct messages, and that's recorded in the Staff log; nobody else can.
  assert.equal((await staff1('/chat-admin/direct')).status, 403);
  assert.equal((await staff1(`/chat-admin/direct/${dm.body.id}`)).status, 403);
  const list = (await admin('/chat-admin/direct')).body;
  assert.ok(list.some((c) => c.id === dm.body.id && c.messages === 1));
  const read = await admin(`/chat-admin/direct/${dm.body.id}`);
  assert.deepEqual(read.body.messages.map((m) => m.body), ['Can you swap Friday?']);
  const logged = db.prepare(`SELECT detail FROM activity_log WHERE action = 'Read a direct message conversation' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(logged.detail.includes(name('staff1@cafe.local')));
  // What people say in chats never goes in the Staff log.
  assert.ok(!db.prepare(`SELECT 1 FROM activity_log WHERE detail LIKE '%swap Friday%'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM activity_log WHERE action = 'Sent a chat message'`).get());

  // Without the permission, direct messages disappear (and you can't be messaged).
  db.prepare('UPDATE users SET custom_permissions = ? WHERE id = ?').run(JSON.stringify(['chat.use']), userId('staff1-2@cafe.local'));
  assert.ok(!(await staff12('/chat')).body.groups.some((g) => g.id === dm.body.id));
  assert.equal((await staff12('/chat/direct/people')).status, 403);
  assert.ok(!(await staff1('/chat/direct/people')).body.some((u) => u.id === userId('staff1-2@cafe.local')));
});
