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


const titles = (list) => list.map((t) => t.title);

test('Trail set up: change, switch off and add checks for one site without touching the others', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const here = manager.me.location_id;
  const there = (await admin('/locations')).data.find((l) => l.active && l.id !== here).id;
  const checklist = async (who, site) => (await who(`/safety/checklist?location_id=${site}`)).data.tasks;

  assert.equal((await (await login('staff1@cafe.local'))(`/safety/setup?location_id=${here}`)).status, 403, 'staff can’t set up checks');
  const setup = (await manager(`/safety/setup?location_id=${here}`)).data;
  const shared = setup.tasks.filter((t) => t.scope === 'shared');
  assert.ok(shared.length >= 2 && shared.every((t) => t.on_here));
  const [a, b] = shared;

  // Switch a shared check off here only.
  assert.equal((await manager(`/safety/tasks/${a.id}/at-site`, { method: 'POST', body: { location_id: here, on: false } })).status, 200);
  assert.ok(!titles(await checklist(manager, here)).includes(a.title));
  assert.ok(titles(await checklist(admin, there)).includes(a.title), 'still on at the other site');
  assert.equal((await manager(`/safety/tasks/${a.id}/at-site`, { method: 'POST', body: { location_id: there, on: false } })).status, 403, 'not their site');
  await manager(`/safety/tasks/${a.id}/at-site`, { method: 'POST', body: { location_id: here, on: true } });
  assert.ok(titles(await checklist(manager, here)).includes(a.title));

  // Change a shared check for this site: its own copy replaces the shared one here.
  const custom = await manager(`/safety/tasks/${b.id}/customise`, { method: 'POST', body: { ...b, title: `${b.title} (ours)`, location_id: here } });
  assert.equal(custom.status, 201);
  let list = titles(await checklist(manager, here));
  assert.ok(list.includes(`${b.title} (ours)`) && !list.includes(b.title));
  assert.ok(titles(await checklist(admin, there)).includes(b.title));
  const after = (await manager(`/safety/setup?location_id=${here}`)).data.tasks;
  assert.equal(after.find((t) => t.id === b.id).replaced_by, custom.data.id);
  assert.equal(after.find((t) => t.id === custom.data.id).replaces_title, b.title);
  assert.equal((await manager(`/safety/tasks/${custom.data.id}/revert`, { method: 'POST' })).status, 200);
  list = titles(await checklist(manager, here));
  assert.ok(list.includes(b.title) && !list.includes(`${b.title} (ours)`));

  // Add a check just for this site; managers can’t add one for every site.
  assert.equal((await manager('/safety/tasks', { method: 'POST', body: { title: 'Everywhere', frequency: 'daily', location_id: null } })).status, 403);
  const own = await manager('/safety/tasks', { method: 'POST', body: { title: 'Check the ice machine', frequency: 'daily', location_id: here } });
  assert.equal(own.status, 201);
  assert.ok(titles(await checklist(manager, here)).includes('Check the ice machine'));
  assert.ok(!titles(await checklist(admin, there)).includes('Check the ice machine'));

  // A check with records is switched off rather than deleted; one without is deleted.
  assert.equal((await manager('/safety/checks', { method: 'POST', body: { task_id: own.data.id, location_id: here } })).status, 201);
  assert.deepEqual((await manager(`/safety/tasks/${own.data.id}`, { method: 'DELETE' })).data, { deleted: false, switched_off: true });
  assert.ok(!titles(await checklist(manager, here)).includes('Check the ice machine'));
  const spare = await manager('/safety/tasks', { method: 'POST', body: { title: 'Spare', frequency: 'weekly', location_id: here } });
  assert.equal((await manager(`/safety/tasks/${spare.data.id}`, { method: 'DELETE' })).data.deleted, true);
  assert.equal((await manager(`/safety/tasks/${a.id}`, { method: 'DELETE' })).status, 403, 'only admins remove shared checks');
});
