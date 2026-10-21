import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { SFBB_CLOSING, SFBB_METHODS, SFBB_OPENING } from '../public/js/sfbb-content.js';
import { addDays, today } from '../src/util.js';

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

test('SFBB: every safe method has a unique key and the pack’s 31 methods are there', () => {
  assert.equal(SFBB_METHODS.length, 31);
  assert.equal(new Set(SFBB_METHODS.map((m) => m.key)).size, 31);
});

test('SFBB pack: a manager answers and signs off a safe method; staff can read it but not change it', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = manager.me.location_id;
  const answers = { 0: { answer: 'yes', note: null }, 3: { answer: null, note: 'Black t-shirt and apron' } };
  assert.equal((await staff('/sfbb/methods/cloths', { method: 'PUT', body: { location_id: site, answers } })).status, 403);
  assert.equal((await manager('/sfbb/methods/not-a-method', { method: 'PUT', body: { location_id: site, answers } })).status, 404);

  assert.equal((await manager('/sfbb/methods/personal-hygiene', { method: 'PUT', body: { location_id: site, answers } })).status, 200);
  let m = (await staff(`/sfbb/pack?location_id=${site}`)).data.methods['personal-hygiene'];
  assert.equal(m.answers[3].note, 'Black t-shirt and apron');
  assert.equal(m.completed_at, null, 'saving alone doesn’t sign it off');

  await manager('/sfbb/methods/personal-hygiene', { method: 'PUT', body: { location_id: site, answers, complete: true } });
  m = (await staff(`/sfbb/pack?location_id=${site}`)).data.methods['personal-hygiene'];
  assert.ok(m.completed_at);
  assert.equal(m.completed_by_name, manager.me.name);
  // Saving again keeps the sign-off; taking it off clears it.
  await manager('/sfbb/methods/personal-hygiene', { method: 'PUT', body: { location_id: site, answers } });
  assert.ok((await manager(`/sfbb/pack?location_id=${site}`)).data.methods['personal-hygiene'].completed_at);
  await manager('/sfbb/methods/personal-hygiene', { method: 'PUT', body: { location_id: site, answers, complete: false } });
  assert.equal((await manager(`/sfbb/pack?location_id=${site}`)).data.methods['personal-hygiene'].completed_at, null);

  await manager('/sfbb/methods/acrylamide', { method: 'PUT', body: { location_id: site, not_relevant: true } });
  assert.equal((await manager(`/sfbb/pack?location_id=${site}`)).data.methods.acrylamide.not_relevant, 1);
});

test('SFBB opening and closing checks: added to the site’s Food Safety Checks once, without duplicates', async () => {
  const manager = await login('manager1@cafe.local');
  const site = manager.me.location_id;
  const before = (await manager(`/sfbb/checks?location_id=${site}`)).data.checks;
  assert.equal(before.length, SFBB_OPENING.length + SFBB_CLOSING.length);
  // New databases start with the pack's wording, so only the first opening check (covered by temperatures) is missing.
  assert.deepEqual(before.filter((c) => !c.added).map((c) => c.title), [SFBB_OPENING[0]]);
  assert.equal((await manager('/sfbb/checks', { method: 'POST', body: { location_id: site } })).data.added, 1);
  assert.equal((await manager('/sfbb/checks', { method: 'POST', body: { location_id: site } })).data.added, 0);
  const tasks = (await manager(`/safety/checklist?location_id=${site}`)).data.tasks;
  assert.equal(tasks.filter((t) => t.title === SFBB_OPENING[0]).length, 1);
});

test('SFBB diary: opening/closing checks, notes, failed checks and the manager’s sign-off', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = staff.me.location_id;
  const d = today();
  const tasks = (await staff(`/safety/checklist?location_id=${site}`)).data.tasks;
  const opening = tasks.filter((t) => t.frequency === 'daily' && t.category === 'Opening checks' && !t.requires_reading);
  await staff('/safety/checks', { method: 'POST', body: { location_id: site, task_id: opening[0].id, status: 'pass' } });
  await staff('/safety/checks', { method: 'POST', body: { location_id: site, task_id: opening[1].id, status: 'fail', corrective_action: 'Called the engineer' } });

  assert.equal((await staff(`/sfbb/diary/${d}`, { method: 'PUT', body: { location_id: site, notes: 'Milk delivery rejected – too warm' } })).status, 200);
  assert.equal((await staff(`/sfbb/diary/${d}/sign`, { method: 'POST', body: { location_id: site } })).status, 403, 'staff can’t sign');
  assert.equal((await manager(`/sfbb/diary/${addDays(d, 1)}/sign`, { method: 'POST', body: { location_id: site } })).status, 400, 'not a future day');
  assert.equal((await manager(`/sfbb/diary/${d}/sign`, { method: 'POST', body: { location_id: site } })).status, 200);
  await staff(`/sfbb/weeks/${d}`, { method: 'PUT', body: { location_id: site, extra_checks: 'Probe checked' } });

  const diary = (await staff(`/sfbb/diary?location_id=${site}&week=${d}`)).data;
  const day = diary.days.find((x) => x.date === d);
  assert.equal(diary.days.length, 7);
  assert.equal(day.opening.done, 2);
  assert.ok(day.opening.total >= 8 && day.closing.total >= 9);
  assert.deepEqual(day.problems.map((p) => p.corrective_action), ['Called the engineer']);
  assert.equal(day.notes, 'Milk delivery rejected – too warm');
  assert.equal(day.signed_by_name, manager.me.name);
  assert.equal(diary.extra_checks, 'Probe checked');

  await manager(`/sfbb/diary/${d}/sign`, { method: 'POST', body: { location_id: site, signed: false } });
  assert.equal((await staff(`/sfbb/diary?location_id=${site}`)).data.days.find((x) => x.date === d).signed_at, null);
  assert.equal((await staff(`/sfbb/diary?location_id=${site}`)).data.days.find((x) => x.date === d).notes, 'Milk delivery rejected – too warm', 'the note stays');
});

test('SFBB 4-weekly review, training record and records', async () => {
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = manager.me.location_id;

  assert.equal((await manager('/sfbb/reviews', { method: 'POST', body: { location_id: site, problems: true } })).status, 400, 'problems need details');
  assert.equal((await staff('/sfbb/reviews', { method: 'POST', body: { location_id: site, problems: false } })).status, 403);
  assert.equal((await manager('/sfbb/reviews', { method: 'POST', body: { location_id: site, problems: false, checklist: { 0: 'yes', 1: 'no', 2: 'maybe' } } })).status, 201);
  const reviews = (await manager(`/sfbb/reviews?location_id=${site}`)).data;
  assert.deepEqual(reviews.reviews[0].checklist, { 0: 'yes', 1: 'no' });
  assert.equal((await manager(`/sfbb/pack?location_id=${site}`)).data.review_due, addDays(today(), 28));

  const people = (await manager(`/sfbb/training?location_id=${site}`)).data.people;
  assert.ok(people.some((p) => p.id === staff.me.id));
  const r = await manager('/sfbb/training', { method: 'POST', body: { location_id: site, user_ids: [staff.me.id], topics: ['factsheet', 'handwashing', 'nonsense'] } });
  assert.equal(r.data.added, 2);
  const recs = (await manager(`/sfbb/training?location_id=${site}`)).data.records.filter((x) => x.user_id === staff.me.id);
  assert.deepEqual(recs.map((x) => x.topic).sort(), ['factsheet', 'handwashing']);

  assert.equal((await staff('/sfbb/starter/cleaning', { method: 'POST', body: { location_id: site } })).status, 403);
  assert.equal((await manager('/sfbb/starter/cleaning', { method: 'POST', body: { location_id: site } })).status, 201);
  assert.equal((await manager('/sfbb/starter/cleaning', { method: 'POST', body: { location_id: site } })).status, 400, 'only into an empty list');
  assert.equal((await staff('/sfbb/prove-it', { method: 'POST', body: { location_id: site, method_key: 'cooking-safely', how: 'Burger probed – 82°C' } })).status, 201, 'staff can record Prove it checks');
  const added = await manager('/sfbb/contacts', { method: 'POST', body: { location_id: site, role: 'Pest control', phone: '0800 1' } });
  assert.equal(added.status, 201);
  assert.equal((await manager(`/sfbb/contacts/${added.data.id}`, { method: 'PUT', body: { role: 'Pest control', name: 'Pestaway' } })).data.name, 'Pestaway');
  const records = (await staff(`/sfbb/records?location_id=${site}`)).data;
  assert.ok(records.cleaning.length >= 5);
  assert.equal(records.prove_it[0].how, 'Burger probed – 82°C');
  assert.equal(records.contacts[0].name, 'Pestaway');
  assert.equal((await manager(`/sfbb/contacts/${added.data.id}`, { method: 'DELETE' })).status, 200);
});
