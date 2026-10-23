import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEFAULT_SETS } from '../src/permissions.js';
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
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), type: r.headers.get('content-type') };
  };
}
const site = (email) => db.prepare('SELECT location_id FROM users WHERE email = ?').get(email).location_id;

test('compliance permissions: staff read risks and report incidents; managers manage all three', () => {
  const staff = DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions;
  assert.ok(staff.includes('risk.view') && staff.includes('incidents.report'));
  assert.ok(!staff.includes('risk.manage') && !staff.includes('incidents.manage') && !staff.includes('compliance.documents'));
  const manager = DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions;
  for (const p of ['risk.manage', 'incidents.manage', 'compliance.documents']) assert.ok(manager.includes(p), p);
});

test('risk assessments: managers write and review them; staff read them', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const made = await manager('/risks', { method: 'POST', body: { location_id: site('manager1@cafe.local'), title: 'Knives', category: 'Health & safety', hazards: 'Cuts', controls: 'Training, cut gloves', likelihood: 3, severity: 4 } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.score, made.data.rating], [12, 'medium']);
  assert.ok(made.data.review_on > new Date().toISOString().slice(0, 10), 'reviewed in a year by default');
  // Only people who work with every site can make one for every site.
  db.prepare('UPDATE users SET all_sites = 0 WHERE email = ?').run('manager1@cafe.local');
  assert.equal((await manager('/risks', { method: 'POST', body: { location_id: '', title: 'x', hazards: 'x', controls: 'x', likelihood: 1, severity: 1 } })).status, 403);
  db.prepare('UPDATE users SET all_sites = 1 WHERE email = ?').run('manager1@cafe.local');
  assert.equal((await manager('/risks', { method: 'POST', body: { title: 'x', hazards: 'x', controls: 'x', likelihood: 6, severity: 1 } })).status, 400);

  const list = await staff('/risks');
  assert.ok(list.data.risks.some((r) => r.title === 'Knives'));
  assert.equal(list.data.can_manage, false);
  assert.equal((await staff(`/risks/${made.data.id}`, { method: 'PUT', body: { title: 'y' } })).status, 403);

  db.prepare(`UPDATE risk_assessments SET review_on = date('now', '-1 day') WHERE id = ?`).run(made.data.id);
  assert.equal((await manager('/compliance/summary')).data.risks_due, 1);
  const reviewed = await manager(`/risks/${made.data.id}/reviewed`, { method: 'POST', body: {} });
  assert.equal(reviewed.data.review_due, false);
  assert.equal((await manager(`/risks/${made.data.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await manager('/risks')).data.risks.some((r) => r.id === made.data.id));
});

test('incidents: anyone reports one; managers at that site see it, follow it up and close it', async () => {
  const staff = await login('staff1@cafe.local');
  const other = await login('staff1-2@cafe.local');
  const manager = await login('manager1@cafe.local');
  const elsewhere = await login('manager2@cafe.local');
  db.prepare('UPDATE users SET all_sites = 0 WHERE email = ?').run('manager2@cafe.local');
  const body = { location_id: site('staff1@cafe.local'), kind: 'accident', occurred_on: new Date().toISOString().slice(0, 10), occurred_at: '10:15', title: 'Cut finger', description: 'Cut while slicing lemons', injury: 'Small cut, plaster' };
  const made = await staff('/incidents', { method: 'POST', body });
  assert.equal(made.status, 201);
  assert.equal(made.data.status, 'open');
  assert.equal((await staff('/incidents', { method: 'POST', body: { ...body, occurred_on: '2999-01-01' } })).status, 400);
  assert.equal((await staff('/incidents', { method: 'POST', body: { ...body, kind: 'nope' } })).status, 400);

  // The reporter sees theirs; another member of staff doesn't; the site's manager does; a manager elsewhere doesn't.
  assert.ok((await staff('/incidents')).data.incidents.some((i) => i.id === made.data.id));
  assert.equal((await other(`/incidents/${made.data.id}`)).status, 404);
  assert.ok((await manager('/incidents')).data.incidents.some((i) => i.id === made.data.id));
  assert.equal((await elsewhere(`/incidents/${made.data.id}`)).status, 404);

  assert.equal((await staff(`/incidents/${made.data.id}/status`, { method: 'POST', body: { status: 'closed', outcome: 'x' } })).status, 403);
  assert.equal((await staff(`/incidents/${made.data.id}/notes`, { method: 'POST', body: { body: 'It’s healed' } })).status, 201);
  assert.equal((await manager(`/incidents/${made.data.id}/status`, { method: 'POST', body: { status: 'closed' } })).status, 400, 'closing needs an outcome');
  const closed = await manager(`/incidents/${made.data.id}/status`, { method: 'POST', body: { status: 'closed', outcome: 'New cut-resistant gloves' } });
  assert.equal(closed.data.status, 'closed');
  const detail = await manager(`/incidents/${made.data.id}`);
  assert.deepEqual(detail.data.notes.map((n) => n.body), ['It’s healed', 'Closed: New cut-resistant gloves']);
  assert.ok(!(await manager('/incidents')).data.incidents.some((i) => i.id === made.data.id), 'closed ones drop off the open list');
  assert.ok((await manager('/incidents?status=closed')).data.incidents.some((i) => i.id === made.data.id));
});

test('compliance documents: uploaded with an expiry date, flagged before they run out', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const made = await manager('/compliance-docs', { method: 'POST', body: { location_id: site('manager1@cafe.local'), title: 'Gas safety', category: 'certificate', expires_on: soon,
    file_name: 'gas.pdf', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') } });
  assert.equal(made.status, 201);
  assert.equal(made.data.expiry, 'soon');
  assert.equal((await manager('/compliance/summary')).data.documents_expiring >= 1, true);
  assert.equal((await staff('/compliance-docs')).status, 403);
  const file = await fetch(`${base}/compliance-docs/${made.data.id}/file`, { headers: { cookie: (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'manager1@cafe.local', password: DEMO_PASSWORD }) })).headers.get('set-cookie').split(';')[0] } });
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal((await manager('/compliance-docs', { method: 'POST', body: { title: 'x', file_name: 'x.exe', media_type: 'application/x-msdownload', data: 'AAAA' } })).status, 400);
  assert.equal((await manager(`/compliance-docs/${made.data.id}`, { method: 'DELETE' })).status, 200);
});

test('upgrading gives everyone risk reading and incident reporting, and check managers the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cmp-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Lead', '', '["safety.manage"]'), ('Floor', '', '["rota.view"]')`).run();
    d.exec('PRAGMA user_version = 21');
    d.close();
    d = openDb(file);
    const perms = (name) => JSON.parse(d.prepare('SELECT permissions FROM permission_sets WHERE name = ?').get(name).permissions);
    assert.ok(['risk.view', 'incidents.report', 'risk.manage', 'incidents.manage', 'compliance.documents'].every((p) => perms('Lead').includes(p)));
    assert.ok(perms('Floor').includes('risk.view') && perms('Floor').includes('incidents.report') && !perms('Floor').includes('incidents.manage'));
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
