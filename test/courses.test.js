import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { youtubeEmbed } from '../src/routes/courses.js';
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
const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

const STEPS = [
  { kind: 'page', title: 'Welcome', body: 'How we make a flat white.', video_url: 'https://youtu.be/dQw4w9WgXcQ' },
  { kind: 'question', title: 'How many shots in a flat white?', options: ['One', 'Two', 'Three'], answer: 1, body: 'Always a double.' },
  { kind: 'question', title: 'Milk temperature?', options: ['40°C', '60–65°C', '90°C'], answer: 1 },
];

async function makeCourse(m, extra = {}) {
  const { data } = await m('/training/courses', { method: 'POST', body: { name: `Barista basics ${Math.random().toString(36).slice(2, 7)}` } });
  const saved = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: STEPS, pass_mark: 100, published: true, ...extra } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return data.id;
}

test('YouTube links become privacy-friendly embeds; other links are refused', () => {
  assert.equal(youtubeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbed('youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbed('https://youtube.com/shorts/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbed('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
});

test('a manager designs a course; questions need two answers and a right one; empty courses can’t be published', async () => {
  const m = await login('manager1@cafe.local');
  const { data } = await m('/training/courses', { method: 'POST', body: { name: 'Allergen basics' } });
  let r = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [], published: true } });
  assert.equal(r.status, 400);
  r = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [{ kind: 'question', title: 'Q', options: ['Only one'], answer: 0 }] } });
  assert.equal(r.status, 400);
  r = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [{ kind: 'question', title: 'Q', options: ['A', 'B'] }] } });
  assert.equal(r.status, 400);
  r = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [{ kind: 'page', video_url: 'https://vimeo.com/123' }] } });
  assert.equal(r.status, 400);
  r = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: STEPS, open_to_all: true } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.course.pages, r.data.course.questions, r.data.course.published], [1, 2, false]);
  const design = (await m(`/training/courses/${data.id}/design`)).data;
  assert.equal(design.steps[1].answer, 1);
  assert.equal(design.steps[0].video_url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  // Staff can't see or take it until it's published, even though it's open to everyone.
  const s = await login('staff1@cafe.local');
  assert.equal((await s(`/learn/${data.id}`)).status, 404);
  assert.ok(!(await s('/learn')).data.some((c) => c.id === data.id));
  // Staff can't design courses.
  assert.equal((await s(`/training/courses/${data.id}/design`)).status, 403);
});

test('assigning a course reaches the person; the answers are never sent to them; passing records the training', async () => {
  const m = await login('manager1@cafe.local');
  const courseId = await makeCourse(m);
  const staff = userId('staff1@cafe.local');
  const due = addDays(today(), 7);
  assert.equal((await m(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: [staff], due_on: addDays(today(), -1) } })).status, 400);
  assert.equal((await m(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: [staff], due_on: due } })).status, 200);
  assert.ok(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'training'`).get(staff));

  const s = await login('staff1@cafe.local');
  const mine = (await s('/learn')).data.find((c) => c.id === courseId);
  assert.deepEqual([mine.status, mine.assigned, mine.due_on], ['to_do', true, due]);
  const course = (await s(`/learn/${courseId}`)).data;
  assert.equal(course.steps.length, 3);
  assert.ok(course.steps.every((st) => st.answer === undefined), 'right answers aren’t sent to the person taking it');
  const [, q1, q2] = course.steps;

  // Not every question answered.
  assert.equal((await s(`/learn/${courseId}/submit`, { method: 'POST', body: { answers: { [q1.id]: 1 } } })).status, 400);
  // A fail: the score, which were wrong, but not the right answers.
  let r = await s(`/learn/${courseId}/submit`, { method: 'POST', body: { answers: { [q1.id]: 0, [q2.id]: 1 } } });
  assert.deepEqual([r.data.score, r.data.passed, r.data.status], [50, false, 'failed']);
  assert.equal(r.data.results[0].correct, false);
  assert.equal(r.data.results[0].answer, null);
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'to_do');
  // A pass records the training.
  r = await s(`/learn/${courseId}/submit`, { method: 'POST', body: { answers: { [q1.id]: 1, [q2.id]: 1 } } });
  assert.deepEqual([r.data.score, r.data.passed, r.data.status], [100, true, 'passed']);
  assert.equal(r.data.results[0].answer, 1);
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'done');
  const rec = db.prepare('SELECT * FROM training_records WHERE course_id = ? AND user_id = ?').get(courseId, staff);
  assert.equal(rec.completed_on, today());
  assert.match(rec.notes, /100%/);
  // The training shows on their My Atlas.
  assert.ok((await s('/training/mine')).data.records.some((x) => x.course_id === courseId));
});

test('people who weren’t given a course can’t take it, unless it’s open to everyone', async () => {
  const m = await login('manager1@cafe.local');
  const courseId = await makeCourse(m);
  const s = await login('staff2@cafe.local');
  assert.equal((await s(`/learn/${courseId}`)).status, 404);
  assert.equal((await s(`/learn/${courseId}/submit`, { method: 'POST', body: { answers: {} } })).status, 404);
  await m(`/training/courses/${courseId}/design`, { method: 'PUT', body: { steps: STEPS, pass_mark: 100, published: true, open_to_all: true } });
  assert.equal((await s(`/learn/${courseId}`)).status, 200);
  assert.ok((await s('/learn')).data.some((c) => c.id === courseId && !c.assigned));
});

test('courses that need a sign-off wait for a manager, who can sign them off or send them back', async () => {
  const m = await login('manager1@cafe.local');
  const courseId = await makeCourse(m, { needs_signoff: true, pass_mark: 50 });
  const staff = userId('staff1-2@cafe.local');
  await m(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: [staff] } });
  const s = await login('staff1-2@cafe.local');
  const [, q1, q2] = (await s(`/learn/${courseId}`)).data.steps;
  const pass = { answers: { [q1.id]: 1, [q2.id]: 0 } };
  let r = await s(`/learn/${courseId}/submit`, { method: 'POST', body: pass });
  assert.deepEqual([r.data.score, r.data.status], [50, 'awaiting_signoff']);
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'awaiting_signoff');
  assert.equal((await s(`/learn/${courseId}/submit`, { method: 'POST', body: pass })).status, 400);
  assert.ok(!db.prepare('SELECT 1 FROM training_records WHERE course_id = ? AND user_id = ?').get(courseId, staff), 'not recorded until signed off');

  let waiting = (await m('/training/designs')).data.signoffs.find((w) => w.course_id === courseId);
  assert.equal(waiting.user_id, staff);
  // Staff can't sign themselves off.
  assert.equal((await s(`/training/attempts/${waiting.id}/decide`, { method: 'POST', body: { approve: true } })).status, 403);
  // Sent back: they take it again.
  await m(`/training/attempts/${waiting.id}/decide`, { method: 'POST', body: { approve: false, notes: 'Let’s practise steaming milk first' } });
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'to_do');
  r = await s(`/learn/${courseId}/submit`, { method: 'POST', body: pass });
  waiting = (await m('/training/designs')).data.signoffs.find((w) => w.course_id === courseId);
  await m(`/training/attempts/${waiting.id}/decide`, { method: 'POST', body: { approve: true } });
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'done');
  assert.match(db.prepare('SELECT notes FROM training_records WHERE course_id = ? AND user_id = ?').get(courseId, staff).notes, /signed off/);
});

test('giving a course again asks someone who’s done it to redo it', async () => {
  const m = await login('manager1@cafe.local');
  const courseId = await makeCourse(m, { steps: [{ kind: 'page', title: 'Read me', body: 'Fire exits are…' }] });
  const staff = userId('staff1-3@cafe.local');
  db.prepare('INSERT INTO training_records (course_id, user_id, completed_on) VALUES (?, ?, ?)').run(courseId, staff, addDays(today(), -30));
  await m(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: [staff] } });
  const s = await login('staff1-3@cafe.local');
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'to_do');
  // A course with no questions is done once they reach the end.
  const r = await s(`/learn/${courseId}/submit`, { method: 'POST', body: { answers: {} } });
  assert.deepEqual([r.data.score, r.data.status], [100, 'passed']);
  assert.equal((await s('/learn')).data.find((c) => c.id === courseId).status, 'done');
});

test('pictures and videos: uploaded by managers, kept with the course, seen only by people who can take it', async () => {
  const m = await login('manager1@cafe.local');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/training/media', { method: 'POST', body: { file_name: 'a.png', media_type: 'image/png', data: png.toString('base64') } })).status, 403);
  const up = await m('/training/media', { method: 'POST', body: { file_name: 'a.png', media_type: 'image/png', data: png.toString('base64') } });
  assert.equal(up.status, 201);
  const { data } = await m('/training/courses', { method: 'POST', body: { name: 'Latte art' } });
  await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [{ kind: 'page', title: 'A heart', media_id: up.data.id }], published: true } });
  const get = async (who) => (await fetch(`${base}/training/media/${up.data.id}`, { headers: { cookie: who } })).status;
  const cookieOf = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) })).headers.get('set-cookie').split(';')[0];
  const staffCookie = await cookieOf('staff1@cafe.local');
  assert.equal(await get(staffCookie), 404);
  await m(`/training/courses/${data.id}/assign`, { method: 'POST', body: { user_ids: [userId('staff1@cafe.local')] } });
  assert.equal(await get(staffCookie), 200);
  // Taking the picture off the course deletes it.
  await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: [{ kind: 'page', title: 'A heart', body: 'Pour slowly' }] } });
  assert.ok(!db.prepare('SELECT 1 FROM training_media WHERE id = ?').get(up.data.id));
});

test('managers who only look after some sites can’t give courses to people elsewhere', async () => {
  const m = await login('manager1@cafe.local');
  const courseId = await makeCourse(m);
  // Demo managers work at one site.
  assert.equal(db.prepare(`SELECT all_sites FROM users WHERE email = 'manager1@cafe.local'`).get().all_sites, 0);
  const r = await m(`/training/courses/${courseId}/assign`, { method: 'POST', body: { user_ids: [userId('staff2@cafe.local')] } });
  assert.equal(r.status, 403);
});

test('a ready-made health & safety course is added as a draft that passes the designer’s own checks', async () => {
  const m = await login('admin@cafe.local');
  const { data: list } = await m('/training/templates');
  const hs = list.templates.find((t) => t.key === 'health-safety-induction');
  assert.ok(hs && hs.pages >= 10 && hs.questions >= 10);
  const { status, data } = await m('/training/templates/health-safety-induction', { method: 'POST' });
  assert.equal(status, 201);
  const { data: design } = await m(`/training/courses/${data.id}/design`);
  assert.equal(design.course.published, false);
  assert.equal(design.course.needs_signoff, true);
  assert.equal(design.steps.length, hs.pages + hs.questions);
  // Saving it unchanged (and publishing) goes through the same rules as a course built by hand.
  const saved = await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: design.steps, published: true } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await m('/training/templates/nope', { method: 'POST' })).status, 404);
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/training/templates')).status, 403);
});

test('deleting a course hides it from staff and the designer but keeps training already done', async () => {
  const m = await login('manager1@cafe.local');
  const { data } = await m('/training/templates/health-safety-induction', { method: 'POST' });
  const { data: design } = await m(`/training/courses/${data.id}/design`);
  await m(`/training/courses/${data.id}/design`, { method: 'PUT', body: { steps: design.steps, published: true } });
  await m(`/training/courses/${data.id}/assign`, { method: 'POST', body: { user_ids: [userId('staff1@cafe.local')] } });
  const staff = await login('staff1@cafe.local');
  assert.ok((await staff('/learn')).data.some((c) => c.id === data.id));
  assert.equal((await m(`/training/courses/${data.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await staff('/learn')).data.some((c) => c.id === data.id));
  assert.ok(!(await m('/training/designs')).data.courses.some((c) => c.id === data.id));
  assert.equal((await m(`/training/courses/${data.id}/design`)).status, 404);
});

test('every ready-made course can be added, saved and published as it is', async () => {
  const m = await login('admin@cafe.local');
  const { data } = await m('/training/templates');
  assert.ok(data.templates.length >= 6);
  for (const t of data.templates) {
    const { data: made } = await m(`/training/templates/${t.key}`, { method: 'POST' });
    const { data: design } = await m(`/training/courses/${made.id}/design`);
    const saved = await m(`/training/courses/${made.id}/design`, { method: 'PUT', body: { steps: design.steps, published: true } });
    assert.equal(saved.status, 200, `${t.key}: ${JSON.stringify(saved.data)}`);
  }
  assert.ok((await m('/training/templates')).data.templates.every((t) => t.added));
});

test('assign courses lists each person with the courses they’ve been given', async () => {
  const m = await login('manager1@cafe.local');
  const c = await makeCourse(m);
  const staffId = userId('staff1@cafe.local');
  await m(`/training/courses/${c}/assign`, { method: 'POST', body: { user_ids: [staffId], due_on: addDays(today(), 3) } });
  const { status, data } = await m('/training/assignments');
  assert.equal(status, 200);
  assert.ok(data.courses.some((x) => x.id === c));
  const me = data.people.find((p) => p.id === staffId);
  const given = me.courses.find((x) => x.course_id === c);
  assert.equal(given.status, 'to_do');
  assert.equal(given.due_on, addDays(today(), 3));
  assert.ok(!data.people.some((p) => p.role === 'admin'));
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/training/assignments')).status, 403);
});
