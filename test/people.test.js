import assert from 'node:assert/strict';
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

const staff = () => db.prepare(`SELECT id, location_id FROM users WHERE email = 'staff1@cafe.local'`).get();

test('managers get the People permission; staff can’t use it', async () => {
  const mgr = db.prepare(`SELECT permissions FROM permission_sets WHERE built_in = 'manager'`).get();
  assert.ok(JSON.parse(mgr.permissions).includes('people.manage'));
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/vacancies')).status, 403);
  assert.equal((await s('/training')).status, 403);
});

test('recruitment: a job with candidates moving through the stages', async () => {
  const a = await login('admin@cafe.local');
  const loc = staff().location_id;
  const job = await a('/vacancies', { method: 'POST', body: { location_id: loc, title: 'Barista', hours: 'Weekends' } });
  assert.equal(job.status, 201);
  const c = await a(`/vacancies/${job.data.id}/candidates`, { method: 'POST', body: { name: 'Sam Bean', phone: '07700 900000' } });
  assert.equal(c.status, 201);
  assert.equal((await a(`/candidates/${c.data.id}`, { method: 'PUT', body: { stage: 'trial', next_step_on: addDays(today(), 2) } })).status, 200);
  assert.equal((await a(`/candidates/${c.data.id}`, { method: 'PUT', body: { stage: 'nope' } })).status, 400);
  const list = (await a(`/vacancies?location_id=${loc}`)).data;
  const j = list.find((x) => x.id === job.data.id);
  assert.equal(j.candidates[0].stage, 'trial');
  assert.equal(j.candidates[0].phone, '07700 900000');
  await a(`/vacancies/${job.data.id}`, { method: 'PUT', body: { status: 'filled' } });
  assert.equal((await a(`/vacancies?location_id=${loc}`)).data.find((x) => x.id === job.data.id).status, 'filled');
  await a(`/vacancies/${job.data.id}`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE id = ?').get(c.data.id).n, 0);
});

test('training: who has done what, and what has run out', async () => {
  const a = await login('admin@cafe.local');
  const u = staff();
  const course = (await a('/training/courses', { method: 'POST', body: { name: 'Food hygiene level 2', renew_months: 12 } })).data.id;
  // Done 13 months ago: out of date. Then done 11.5 months ago: due within the month.
  await a('/training/records', { method: 'POST', body: { course_id: course, user_ids: [u.id], completed_on: addDays(today(), -400) } });
  let rec = (await a(`/training?location_id=${u.location_id}`)).data.records.find((r) => r.user_id === u.id && r.course_id === course);
  assert.equal(rec.status, 'expired');
  await a('/training/records', { method: 'POST', body: { course_id: course, user_ids: [u.id], completed_on: addDays(today(), -350) } });
  rec = (await a(`/training?location_id=${u.location_id}`)).data.records.find((r) => r.user_id === u.id && r.course_id === course);
  assert.equal(rec.status, 'due_soon');
  await a('/training/records', { method: 'POST', body: { course_id: course, user_ids: [u.id], completed_on: today() } });
  rec = (await a(`/training?location_id=${u.location_id}`)).data.records.find((r) => r.user_id === u.id && r.course_id === course);
  assert.equal(rec.status, 'done');
  assert.equal((await a(`/training/people/${u.id}`)).data.records.length, 3);
  assert.equal((await a('/training/records', { method: 'POST', body: { course_id: course, user_ids: [u.id], completed_on: addDays(today(), 3) } })).status, 400);
  // A removed course disappears from the matrix but the records stay.
  await a(`/training/courses/${course}`, { method: 'DELETE' });
  assert.ok(!(await a('/training')).data.courses.some((c) => c.id === course));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_records WHERE course_id = ?').get(course).n, 3);
});

test('performance: reviews, the latest one and when the next is overdue', async () => {
  const a = await login('admin@cafe.local');
  const u = staff();
  await a('/performance/reviews', { method: 'POST', body: { user_id: u.id, review_date: addDays(today(), -100), kind: 'probation', rating: 4, went_well: 'Great with customers', next_review_on: addDays(today(), -10) } });
  let row = (await a(`/performance?location_id=${u.location_id}`)).data.find((p) => p.id === u.id);
  assert.equal(row.last.kind, 'probation');
  assert.equal(row.overdue, true);
  const r = await a('/performance/reviews', { method: 'POST', body: { user_id: u.id, review_date: today(), rating: 5, next_review_on: addDays(today(), 90) } });
  row = (await a(`/performance?location_id=${u.location_id}`)).data.find((p) => p.id === u.id);
  assert.equal(row.last.rating, 5);
  assert.equal(row.overdue, false);
  assert.equal(row.reviews, 2);
  assert.equal((await a('/performance/reviews', { method: 'POST', body: { user_id: u.id, review_date: today(), rating: 9 } })).status, 400);
  assert.equal((await a(`/performance/reviews/${r.data.id}`, { method: 'PUT', body: { goals: 'Learn latte art' } })).status, 200);
  const h = (await a(`/performance/people/${u.id}`)).data;
  assert.equal(h.reviews[0].goals, 'Learn latte art');
  assert.equal(h.reviews[0].rating, 5);
});

test('areas: who is learning or trained in each', async () => {
  const a = await login('admin@cafe.local');
  const u = staff();
  const bar = (await a('/areas', { method: 'POST', body: { name: 'Bar' } })).data.id;
  assert.equal((await a('/areas', { method: 'POST', body: { name: 'bar' } })).status, 400);
  await a(`/areas/${bar}/people/${u.id}`, { method: 'PUT', body: { level: 'learning' } });
  await a(`/areas/${bar}/people/${u.id}`, { method: 'PUT', body: { level: 'trained' } });
  let d = (await a(`/areas?location_id=${u.location_id}`)).data;
  assert.deepEqual(d.links.filter((l) => l.user_id === u.id), [{ user_id: u.id, area_id: bar, level: 'trained' }]);
  await a(`/areas/${bar}/people/${u.id}`, { method: 'PUT', body: { level: null } });
  d = (await a(`/areas?location_id=${u.location_id}`)).data;
  assert.equal(d.links.filter((l) => l.user_id === u.id).length, 0);
  await a(`/areas/${bar}`, { method: 'DELETE' });
  assert.ok(!(await a('/areas')).data.areas.some((x) => x.id === bar));
  // Adding it back brings the same area back.
  assert.equal((await a('/areas', { method: 'POST', body: { name: 'Bar' } })).data.id, bar);
});

test('a manager only sees people and jobs at their own sites', async () => {
  const me = db.prepare(`SELECT id, location_id, all_sites FROM users WHERE email = 'manager1@cafe.local'`).get();
  db.prepare('UPDATE users SET all_sites = 0 WHERE id = ?').run(me.id);
  try {
    const other = db.prepare(`SELECT id, location_id FROM users WHERE role != 'admin' AND active = 1 AND location_id != ? LIMIT 1`).get(me.location_id);
    const m2 = await login('manager1@cafe.local');
    const ppl = (await m2('/performance')).data;
    assert.ok(ppl.every((p) => p.location_id === me.location_id));
    if (other) {
      assert.equal((await m2(`/performance/people/${other.id}`)).status, 404);
      assert.equal((await m2('/vacancies', { method: 'POST', body: { location_id: other.location_id, title: 'Chef' } })).status, 403);
    }
  } finally {
    db.prepare('UPDATE users SET all_sites = ? WHERE id = ?').run(me.all_sites, me.id);
  }
});

test('staff see their own training (and only theirs) for My Brew', async () => {
  const a = await login('admin@cafe.local');
  const s = await login('staff1@cafe.local');
  const u = staff();
  const other = db.prepare(`SELECT id FROM users WHERE email = 'staff2@cafe.local'`).get();
  const fire = (await a('/training/courses', { method: 'POST', body: { name: 'Fire safety', renew_months: 12 } })).data.id;
  const allergens = (await a('/training/courses', { method: 'POST', body: { name: 'Allergens', renew_months: 12 } })).data.id;
  await a('/training/records', { method: 'POST', body: { course_id: fire, user_ids: [u.id], completed_on: addDays(today(), -400) } });
  if (other) await a('/training/records', { method: 'POST', body: { course_id: allergens, user_ids: [other.id], completed_on: today() } });
  const mine = await s('/training/mine');
  assert.equal(mine.status, 200);
  const f = mine.data.records.find((r) => r.course_id === fire);
  assert.equal(f.status, 'expired');
  assert.ok(!mine.data.records.some((r) => r.course_id === allergens));
  assert.ok(mine.data.not_done.some((c) => c.course_id === allergens));
  // They still can't see anyone else's.
  assert.equal((await s(`/training/people/${u.id}`)).status, 403);
});
