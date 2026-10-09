import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today, weekStart } from '../src/util.js';

let server;
let base;
let db;
// A pretend Claude: returns whatever the test sets.
let reading = null;
let lastContext = null;
const reader = { model: 'test', async read(_file, context) { lastContext = context; return reading(context); } };

before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { rotaReader: reader }).listen(0);
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
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const user = (email) => db.prepare('SELECT id, name, location_id FROM users WHERE email = ?').get(email);

test('only admins can upload a rota to read', async () => {
  reading = () => ({ is_rota: true, week_starting: '', shifts: [], notes: '' });
  const m = await login('manager1@cafe.local');
  assert.equal((await m('/rota/import/read', { method: 'POST', body: { media_type: 'image/png', data: png } })).status, 403);
  assert.equal((await m('/rota/import/apply', { method: 'POST', body: { shifts: [{}] } })).status, 403);
});

test('Claude’s reading is matched to the team and checked; nothing is added until it’s confirmed', async () => {
  const a = await login('admin@cafe.local');
  const week = weekStart(addDays(today(), 14));
  const sam = user('staff1@cafe.local');
  const riley = user('staff1-2@cafe.local');
  const site = db.prepare('SELECT name FROM locations WHERE id = ?').get(sam.location_id).name;
  // Riley already works Tuesday 09:00–17:00 (draft).
  db.prepare('DELETE FROM shifts WHERE date >= ?').run(week);
  db.prepare('INSERT INTO shifts (location_id, user_id, date, start_time, end_time) VALUES (?, ?, ?, ?, ?)').run(riley.location_id, riley.id, addDays(week, 1), '09:00', '17:00');
  reading = (ctx) => ({
    is_rota: true, week_starting: ctx.week[0], notes: 'Sunday is cut off',
    shifts: [
      { person: sam.name, written_as: sam.name, date: ctx.week[0], start_time: '07:00', end_time: '15:00', break_minutes: 30, site, role: 'Barista', notes: 'Keys', unsure: '' },
      { person: '', written_as: riley.name.split(' ')[0].toLowerCase(), date: ctx.week[1], start_time: '12:00', end_time: '18:00', break_minutes: null, site: '', role: '', notes: '', unsure: '' },
      { person: '', written_as: 'Priya', date: ctx.week[2], start_time: '09:00', end_time: '17:00', break_minutes: null, site, role: '', notes: '', unsure: 'Not on the team list' },
      { person: sam.name, written_as: 'S', date: ctx.week[3], start_time: '25:00', end_time: '17:00', break_minutes: null, site, role: '', notes: '', unsure: '' },
      { person: sam.name, written_as: sam.name, date: ctx.week[4], start_time: '08:00', end_time: '14:00', break_minutes: null, site, role: '', notes: '', unsure: '7 or 1?' },
    ],
  });
  const before = db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n;
  const r = await a('/rota/import/read', { method: 'POST', body: { media_type: 'image/png', data: png, location_id: sam.location_id, week } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, before, 'reading adds nothing');
  // Claude was told the week, the sites and the team.
  assert.equal(lastContext.week[0], week);
  assert.ok(lastContext.team.some((t) => t.name === sam.name));
  const [p1, p2, p3, p4, p5] = r.data.proposals;
  assert.deepEqual([p1.status, p1.user_id, p1.location_id, p1.break_minutes, p1.notes], ['ready', sam.id, sam.location_id, 30, 'Keys']);
  assert.equal(p2.user_id, riley.id, 'matched from a first name');
  assert.equal(p2.status, 'clash');
  assert.match(p2.problem, /09:00–17:00/);
  assert.deepEqual([p3.status, p3.user_id], ['check', null]);
  assert.equal(p4.status, 'check');
  assert.equal(p5.status, 'check');
  assert.equal(p5.problem, '7 or 1?');
  assert.equal(r.data.notes, 'Sunday is cut off');

  // Add the ready one and the fixed-up unknown person; the clash is skipped.
  const add = await a('/rota/import/apply', { method: 'POST', body: { shifts: [
    { ...p1 }, { ...p3, user_id: user('staff1-3@cafe.local').id }, { ...p2 },
  ] } });
  assert.equal(add.status, 200);
  assert.equal(add.data.added, 2);
  assert.equal(add.data.skipped.length, 1);
  assert.match(add.data.skipped[0].problem, /already has/);
  const created = db.prepare('SELECT * FROM shifts WHERE id = ?').get(add.data.ids[0]);
  assert.deepEqual([created.user_id, created.start_time, created.pub_user_id], [sam.id, '07:00', null], 'added as a draft, not published');
  assert.ok(db.prepare(`SELECT 1 FROM rota_log WHERE details LIKE '%from an uploaded rota%'`).get());
  // Reading the same rota again flags what's already there.
  const again = await a('/rota/import/read', { method: 'POST', body: { media_type: 'image/png', data: png, location_id: sam.location_id, week } });
  assert.equal(again.data.proposals[0].status, 'exists');
  // One undo takes the whole lot back off.
  assert.equal((await a('/rota/undo', { method: 'POST' })).status, 200);
  assert.ok(!db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(add.data.ids[0]));
});

test('things that aren’t rotas are turned away', async () => {
  const a = await login('admin@cafe.local');
  reading = () => ({ is_rota: false, week_starting: '', shifts: [], notes: '' });
  const r = await a('/rota/import/read', { method: 'POST', body: { media_type: 'application/pdf', data: png } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /doesn’t look like a rota/);
  assert.equal((await a('/rota/import/read', { method: 'POST', body: { media_type: 'text/plain', data: png } })).status, 400);
});

test('the Claude reader streams (big rotas take a while) and turns problems into plain messages', async () => {
  const { claudeRotaReader } = await import('../src/rota-reader.js');
  const context = { week: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'], team: [{ name: 'Sam' }], sites: [{ name: 'High Street' }] };
  let sent = null;
  const ok = { beta: { messages: { stream: (params) => { sent = params; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"is_rota":true,"week_starting":"","shifts":[],"notes":""}' }] }) }; } } } };
  const r = await claudeRotaReader({ client: ok }).read({ media_type: 'application/pdf', data: 'JVBERi0=' }, context);
  assert.equal(r.is_rota, true);
  assert.equal(sent.messages[0].content[0].type, 'document', 'PDFs go as documents');
  assert.match(sent.messages[0].content[1].text, /Sam/);
  const broken = { beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('socket hang up'); } }) } } };
  await assert.rejects(claudeRotaReader({ client: broken }).read({ media_type: 'image/png', data: 'x' }, context), (err) => err.status === 502 && /socket hang up/.test(err.message));
});
