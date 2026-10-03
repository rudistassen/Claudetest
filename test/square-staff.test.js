import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SquareClient } from '../src/square.js';

// A pretend Square team, recording what Brewly sends.
const calls = [];
const members = new Map();
const wages = new Map();
const jobs = [{ id: 'JOB_BAR', title: 'Barista' }];
let refuseNext = null;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path, body });
  if (refuseNext && method !== 'GET') { const detail = refuseNext; refuseNext = null; return json(400, { errors: [{ code: 'INVALID_VALUE', detail }] }); }
  if (path === '/v2/team-members/search') return json(200, { team_members: [...members.values()] });
  if (path === '/v2/team-members/jobs') {
    if (method === 'GET') return json(200, { jobs });
    const job = { id: `JOB_${jobs.length + 1}`, title: body.job.title };
    jobs.push(job);
    return json(200, { job });
  }
  if (path === '/v2/team-members' && method === 'POST') {
    const m = { id: `TM${members.size + 1}`, status: 'ACTIVE', ...body.team_member };
    members.set(m.id, m);
    return json(200, { team_member: m });
  }
  const [, id, wage] = path.match(/^\/v2\/team-members\/([^/]+)(\/wage-setting)?$/) ?? [];
  if (!members.has(id)) return json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Team member not found' }] });
  if (wage) {
    if (method === 'PUT') wages.set(id, { ...body.wage_setting, version: (wages.get(id)?.version ?? 0) + 1 });
    return json(200, { wage_setting: wages.get(id) ?? { job_assignments: [], version: 0 } });
  }
  if (method === 'PUT') members.set(id, { ...members.get(id), ...body.team_member });
  return json(200, { team_member: members.get(id) });
}

let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  db.prepare(`UPDATE locations SET square_location_id = 'SQ_' || id`).run();
  const config = { token: 't', environment: 'production', baseUrl: 'https://square.test', version: '2025-01-23' };
  server = createApp(db, { square: { config, client: new SquareClient(config, fakeFetch) } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  return call;
}

test('adding someone in Brewly adds them to Square with their site, job and pay, and later changes follow', async () => {
  const admin = await login('admin@cafe.local');
  assert.equal((await admin('/invites/settings')).data.square_ready, true);
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const made = await admin('/users', { method: 'POST', body: { name: 'Mia van der Berg', email: 'mia@brewly-test.co.uk', location_id: site, role: 'staff', rota_group: 'Kitchen', hourly_rate: 12.6, add_to_square: true } });
  assert.equal(made.status, 201);
  assert.equal(made.data.square_sync.status, 'created');
  const m = members.get(made.data.square_sync.member_id);
  assert.equal(m.given_name, 'Mia');
  assert.equal(m.family_name, 'van der Berg');
  assert.equal(m.email_address, 'mia@brewly-test.co.uk');
  assert.deepEqual(m.assigned_locations, { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [`SQ_${site}`] }, 'their home site, not every site');
  assert.equal(jobs.at(-1).title, 'Kitchen', 'a job made for their role');
  assert.deepEqual(wages.get(m.id).job_assignments, [{ job_id: jobs.at(-1).id, pay_type: 'HOURLY', hourly_rate: { amount: 1260, currency: 'GBP' } }]);
  assert.equal((await admin('/users')).data.find((u) => u.id === made.data.id).square_member_id, m.id);

  // A pay rise and a rename are copied; a second job they have in Square is kept.
  wages.set(m.id, { job_assignments: [...wages.get(m.id).job_assignments, { job_id: 'JOB_BAR', pay_type: 'HOURLY', hourly_rate: { amount: 1100, currency: 'GBP' } }], version: 7 });
  const other = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1 OFFSET 1').get().id;
  const edited = await admin(`/users/${made.data.id}`, { method: 'PUT', body: { ...made.data, name: 'Mia Berg', hourly_rate: 13, location_id: other, permission_set_id: made.data.access_set_id } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.square_sync.status, 'updated');
  assert.equal(members.get(m.id).family_name, 'Berg');
  assert.deepEqual(members.get(m.id).assigned_locations.location_ids, [`SQ_${site}`, `SQ_${other}`], 'the new home site is added, none removed');
  const wagePut = calls.filter((c) => c.path.endsWith('/wage-setting') && c.method === 'PUT').at(-1).body.wage_setting;
  assert.equal(wagePut.version, 7);
  assert.deepEqual(wagePut.job_assignments.map((j) => [j.job_id, j.hourly_rate.amount]), [[jobs.at(-1).id, 1300], ['JOB_BAR', 1100]]);

  // Deactivating (in bulk) deactivates them in Square.
  const bulk = await admin('/users/bulk', { method: 'POST', body: { ids: [made.data.id], changes: { active: false } } });
  assert.equal(bulk.data.square_updated, 1);
  assert.equal(members.get(m.id).status, 'INACTIVE');
});

test('someone already in Square with the same email is linked, not added twice; refusals are reported but Brewly still saves', async () => {
  const admin = await login('admin@cafe.local');
  members.set('TM_EXISTING', { id: 'TM_EXISTING', given_name: 'Olu', family_name: 'A', email_address: 'olu@brewly-test.co.uk', status: 'ACTIVE',
    assigned_locations: { assignment_type: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' } });
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const before = members.size;
  const r = await admin('/users', { method: 'POST', body: { name: 'Olu Adeyemi', email: 'OLU@brewly-test.co.uk', location_id: site, role: 'staff', add_to_square: true } });
  assert.equal(r.data.square_sync.status, 'linked');
  assert.equal(members.size, before);
  assert.equal(members.get('TM_EXISTING').family_name, 'Adeyemi');
  assert.equal(members.get('TM_EXISTING').assigned_locations.assignment_type, 'ALL_CURRENT_AND_FUTURE_LOCATIONS', 'their Square locations are left alone');

  // Not ticked: nothing goes to Square.
  const quiet = await admin('/users', { method: 'POST', body: { name: 'No Square', email: 'nosq@brewly-test.co.uk', location_id: site, role: 'staff' } });
  assert.equal(quiet.data.square_sync, null);
  assert.equal(members.size, before);

  refuseNext = 'Email address is invalid';
  const refused = await admin('/users', { method: 'POST', body: { name: 'Pat Refused', email: 'pat@brewly-test.co.uk', location_id: site, role: 'staff', add_to_square: true } });
  assert.equal(refused.status, 201, 'saved in Brewly');
  assert.deepEqual(refused.data.square_sync, { status: 'error', error: 'Email address is invalid' });
});
