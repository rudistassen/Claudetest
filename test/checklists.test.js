import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

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
const user = (email) => db.prepare('SELECT id, location_id FROM users WHERE email = ?').get(email);
const weekday = (d) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

test('checklists: daily lists show on their days, staff tick today only, managers catch up a week', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = user('manager1@cafe.local').location_id;

  // Only admins can set up a list for every site.
  assert.equal((await manager('/checklists', { method: 'POST', body: { name: 'All', location_id: null, items: ['x'] } })).status, 403);
  const all = await admin('/checklists', { method: 'POST', body: { name: 'Opening', location_id: null, days: '1234567', items: ['Lights on', 'Tills open'] } });
  assert.equal(all.status, 201, JSON.stringify(all.data));
  const notToday = String((weekday(today()) % 7) + 1);
  const own = await manager('/checklists', { method: 'POST', body: { name: 'Deep clean', location_id: site, days: notToday, items: ['Fridges'] } });
  assert.equal(own.status, 201, JSON.stringify(own.data));
  assert.equal((await manager(`/checklists/${all.data.id}`, { method: 'PUT', body: { name: 'Mine now', items: ['x'] } })).status, 403);

  const day = await staff(`/checklists?location_id=${site}`);
  assert.equal(day.status, 200);
  assert.deepEqual(day.data.checklists.map((c) => c.name), ['Opening']); // the deep clean isn't on today
  const [first] = day.data.checklists[0].items;

  assert.equal((await staff(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site } })).status, 200);
  const after = await staff(`/checklists?location_id=${site}`);
  assert.equal(after.data.checklists[0].done, 1);
  assert.equal(after.data.checklists[0].items[0].done_by_name, db.prepare('SELECT name FROM users WHERE email = ?').get('staff1@cafe.local').name);

  // Yesterday: staff can't, managers can; more than a week back nobody can; tomorrow never.
  const yesterday = addDays(today(), -1);
  assert.equal((await staff(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site, date: yesterday } })).status, 403);
  assert.equal((await manager(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site, date: yesterday } })).status, 200);
  assert.equal((await manager(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site, date: addDays(today(), -8) } })).status, 403);
  assert.equal((await manager(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site, date: addDays(today(), 1) } })).status, 400);

  // Unticking, and a site's own list can't be ticked at another site.
  await staff(`/checklists/items/${first.id}/tick`, { method: 'POST', body: { location_id: site, done: false } });
  assert.equal((await staff(`/checklists?location_id=${site}`)).data.checklists[0].done, 0);
  const ownItem = (await manager('/checklists/setup')).data.find((c) => c.id === own.data.id).items[0];
  const other = db.prepare('SELECT id FROM locations WHERE id != ? ORDER BY id LIMIT 1').get(site).id;
  assert.equal((await admin(`/checklists/items/${ownItem.id}/tick`, { method: 'POST', body: { location_id: other } })).status, 400);

  // Staff can't set up checklists.
  assert.equal((await staff('/checklists/setup')).status, 403);
});

test('tasks: given to a person, a role or a site; repeating tasks move on; one-offs can be reopened', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const other = await login('staff1-2@cafe.local');
  const s1 = user('staff1@cafe.local');
  const site = s1.location_id;
  db.prepare(`UPDATE users SET rota_group = 'Bar' WHERE email = 'staff1@cafe.local'`).run();
  db.prepare(`UPDATE users SET rota_group = 'Kitchen' WHERE email = 'staff1-2@cafe.local'`).run();

  const person = await manager('/tasks', { method: 'POST', body: { title: 'Clean grinder', assign_to: 'person', user_id: s1.id, due_on: today(), repeat: 'weekly' } });
  assert.equal(person.status, 201, JSON.stringify(person.data));
  const role = await manager('/tasks', { method: 'POST', body: { title: 'Restock syrups', assign_to: 'role', role: 'Bar', location_id: site } });
  const whole = await manager('/tasks', { method: 'POST', body: { title: 'Fire drill', assign_to: 'site', location_id: site, due_on: addDays(today(), -2) } });
  assert.equal(role.status, 201); assert.equal(whole.status, 201);
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task'`).get(s1.id), 'they get a notification');

  const mine = (await staff('/tasks/mine')).data.map((t) => t.title).sort();
  assert.deepEqual(mine, ['Clean grinder', 'Fire drill', 'Restock syrups']);
  assert.deepEqual((await other('/tasks/mine')).data.map((t) => t.title), ['Fire drill']);
  assert.equal((await staff('/tasks')).status, 403, 'only managers see everyone’s tasks');
  const all = (await manager(`/tasks?location_id=${site}`)).data;
  assert.equal(all.find((t) => t.title === 'Fire drill').status, 'overdue');

  // Someone else's task can't be ticked off.
  assert.equal((await other(`/tasks/${person.data.id}/done`, { method: 'POST', body: {} })).status, 403);
  // Weekly: done today → due next week, still open.
  const done = await staff(`/tasks/${person.data.id}/done`, { method: 'POST', body: { note: 'Done with tablets' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.next_due_on, addDays(today(), 7));
  assert.equal(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(person.data.id).done_at, null);
  assert.equal((await staff(`/tasks/${person.data.id}/history`)).data.length, 1);

  // One-off: done, then reopened.
  assert.equal((await other(`/tasks/${whole.data.id}/done`, { method: 'POST', body: {} })).status, 200);
  assert.ok((await manager(`/tasks?status=done&location_id=${site}`)).data.some((t) => t.id === whole.data.id));
  assert.equal((await other(`/tasks/${whole.data.id}/done`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await staff(`/tasks/${whole.data.id}/reopen`, { method: 'POST' })).status, 403, 'only whoever did it or a manager');
  assert.equal((await manager(`/tasks/${whole.data.id}/reopen`, { method: 'POST' })).status, 200);
  assert.ok((await other('/tasks/mine')).data.some((t) => t.id === whole.data.id));

  // A manager can't give tasks at another site.
  const elsewhere = db.prepare('SELECT id FROM locations WHERE id != ? ORDER BY id LIMIT 1').get(site).id;
  assert.equal((await manager('/tasks', { method: 'POST', body: { title: 'X', assign_to: 'site', location_id: elsewhere } })).status, 403);
});

test('to-do lists are private to each person', async () => {
  const m1 = await login('manager1@cafe.local');
  const m2 = await login('manager2@cafe.local');
  const staff = await login('staff1@cafe.local');
  const added = await m1('/todos', { method: 'POST', body: { text: 'Ring the landlord', due_on: addDays(today(), 1) } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal((await m1('/todos')).data.length, 1);
  assert.equal((await m2('/todos')).data.length, 0);
  assert.equal((await m2(`/todos/${added.data.id}`, { method: 'PUT', body: { done: true } })).status, 404);
  assert.equal((await m2(`/todos/${added.data.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await m1(`/todos/${added.data.id}`, { method: 'PUT', body: { done: true } })).status, 200);
  assert.ok((await m1('/todos')).data[0].done_at);
  assert.equal((await staff('/todos')).status, 403, 'staff don’t have a to-do list by default');
});

test('people who could do or set up compliance checks get checklists & tasks after upgrading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-ck-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Checker', '', '["safety.complete"]'), ('Lead', '', '["safety.manage"]'), ('Other', '', '["rota.view"]')`).run();
    d.prepare(`INSERT INTO users (name, email, password_hash, role, custom_permissions) VALUES ('Custom', 'c@x', 'x', 'staff', '["safety.manage"]')`).run();
    d.exec('PRAGMA user_version = 15');
    d.close();
    d = openDb(file);
    // (Later upgrades give everyone My Atlas, Time off and My availability – left out here.)
    const later = ['mybrew.view', 'leave.request', 'availability.own'];
    const set = (name) => JSON.parse(d.prepare('SELECT permissions FROM permission_sets WHERE name = ?').get(name).permissions).filter((p) => !later.includes(p));
    assert.deepEqual(set('Checker'), ['safety.complete', 'checklists.complete']);
    assert.deepEqual(set('Lead'), ['safety.manage', 'checklists.complete', 'checklists.manage', 'tasks.manage', 'todo.use']);
    assert.deepEqual(set('Other'), ['rota.view']);
    const custom = JSON.parse(d.prepare(`SELECT custom_permissions FROM users WHERE email = 'c@x'`).get().custom_permissions);
    assert.ok(custom.includes('tasks.manage') && custom.includes('todo.use'));
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
