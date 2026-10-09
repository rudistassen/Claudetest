import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { demoRotaAnalyst } from '../src/rota-analyst.js';
import { today, weekStart } from '../src/util.js';

let server;
let base;
let db;
// A pretend Claude: returns whatever the test sets, and keeps what it was sent.
let answer = null;
let sent = null;
const analyst = { model: 'test', async analyse(week) { sent = week; return answer(week); } };

before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { rotaAnalyst: analyst }).listen(0);
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
const week = weekStart(today());
// Starts an analysis and waits for it, as the page does.
async function analyse(as, body) {
  const start = await as('/rota/analyse', { method: 'POST', body });
  if (start.status !== 202) return start;
  for (let i = 0; i < 50; i += 1) {
    const r = await as(`/rota/analyse/${start.data.job}`);
    if (r.data.status !== 'running') return r;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('analysis never finished');
}

test('only admins can analyse the rota', async () => {
  answer = () => ({ headline: '', recommendations: [], watch_outs: [] });
  const m = await login('manager1@cafe.local');
  assert.equal((await m('/rota/analyse', { method: 'POST', body: { location_id: 'all', week } })).status, 403);
});

test('the week is sent with forecasts, hourly cover and every shift; savings are worked out from the shifts', async () => {
  const a = await login('admin@cafe.local');
  const shift = db.prepare(`SELECT s.*, u.hourly_rate FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.date BETWEEN ? AND date(?, '+6 days') AND s.removed = 0 AND u.hourly_rate > 0 ORDER BY s.id LIMIT 1`).get(week, week);
  assert.ok(shift, 'the demo week has shifts');
  const site = db.prepare('SELECT name FROM locations WHERE id = ?').get(shift.location_id).name;
  const [h, m] = shift.end_time.split(':').map(Number);
  const earlier = `${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  answer = () => ({
    headline: 'Looks a little heavy on quiet afternoons.',
    recommendations: [
      { site, date: shift.date, kind: 'finish_earlier', title: 'Finish an hour earlier', reason: 'Quiet', shift_ids: [shift.id, 999999], new_start_time: '', new_end_time: earlier, saving: 1000, confidence: 'high' },
      { site, date: shift.date, kind: 'cut_shift', title: 'Drop it', reason: 'Quiet', shift_ids: [shift.id], new_start_time: '', new_end_time: '', saving: null, confidence: 'low' },
    ],
    watch_outs: ['Saturday lunch looks thin'],
  });
  const { status, data } = await analyse(a, { location_id: 'all', week });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.status, 'done');
  // What Claude was sent.
  const sentSite = sent.sites.find((x) => x.name === site);
  const sentDay = sentSite.days.find((d) => d.date === shift.date);
  assert.equal(sentDay.people_on_by_hour.length, 24);
  assert.ok(sentDay.shifts.some((s) => s.id === shift.id && s.hourly_cost === shift.hourly_rate));
  assert.equal(sent.labour_target_pct, 30);
  // Unknown shift ids are dropped and savings are recalculated, not taken from Claude.
  const [finish, cut] = data.recommendations;
  assert.deepEqual(finish.shift_ids, [shift.id]);
  assert.equal(finish.saving, Math.round(shift.hourly_rate * 100) / 100);
  assert.ok(cut.saving > finish.saving);
  assert.equal(data.watch_outs[0], 'Saturday lunch looks thin');
  assert.ok(data.sites.length >= 1 && data.sites[0].days.length === 7);
  // Nothing on the rota changed.
  assert.equal(db.prepare('SELECT end_time FROM shifts WHERE id = ?').get(shift.id).end_time, shift.end_time);
});

test('the demo stand-in gives suggestions from the same data', async () => {
  answer = (w) => demoRotaAnalyst().analyse(w);
  const a = await login('admin@cafe.local');
  const { status, data } = await analyse(a, { location_id: 'all', week });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.recommendations));
});

test('the analysis runs in the background, and a failure is reported back', async () => {
  let release;
  answer = () => new Promise((ok, fail) => { release = fail; });
  const a = await login('admin@cafe.local');
  const start = await a('/rota/analyse', { method: 'POST', body: { location_id: 'all', week } });
  assert.equal(start.status, 202);
  assert.equal((await a(`/rota/analyse/${start.data.job}`)).data.status, 'running');
  release(new Error('Claude is busy – try again in a minute'));
  await new Promise((ok) => setTimeout(ok, 20));
  const r = await a(`/rota/analyse/${start.data.job}`);
  assert.deepEqual(r.data, { status: 'failed', error: 'Claude is busy – try again in a minute' });
  assert.equal((await a('/rota/analyse/nope')).status, 404);
});

test('a finished analysis is saved, so its suggestions can be opened again from the rota', async () => {
  answer = () => ({ headline: 'Saved one', recommendations: [], watch_outs: [] });
  const a = await login('admin@cafe.local');
  const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
  const done = await analyse(a, { location_id: site, week });
  assert.equal(done.data.status, 'done');
  const latest = await a(`/rota/analyses/latest?location_id=${site}&week=${week}`);
  assert.equal(latest.data.analysis.id, done.data.id);
  assert.equal(latest.data.analysis.headline, 'Saved one');
  assert.ok(latest.data.analysis.created_at);
  // The rota tells admins there's one to open; the whole-group view keeps its own.
  assert.equal((await a(`/rota?location_id=${site}&week=${week}`)).data.last_analysis.id, done.data.id);
  assert.notEqual((await a(`/rota?location_id=all&week=${week}`)).data.last_analysis?.id, done.data.id);
  const m = await login('manager1@cafe.local');
  assert.equal((await m(`/rota?week=${week}`)).data.last_analysis, undefined);
  assert.equal((await m(`/rota/analyses/latest?week=${week}`)).status, 403);
});
