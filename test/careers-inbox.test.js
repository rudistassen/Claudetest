import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkCareers, cvAttachments, fillTemplate, findPhone } from '../src/careers-inbox.js';
import { openDb } from '../src/db.js';
import { graphMailbox, memoryMailbox } from '../src/mailbox.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

const pdf = Buffer.from('%PDF-1.4 a CV %%EOF').toString('base64');
const hours = (h) => new Date(Date.now() - h * 3600000).toISOString();

let server;
let base;
let db;
let box;
let jobId;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const site = db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY id').get();
  jobId = Number(db.prepare(`INSERT INTO vacancies (location_id, title) VALUES (?, 'Barista')`).run(site.id).lastInsertRowid);
  box = memoryMailbox([
    { id: 'm1', subject: 'Application for Barista', from: 'maya@example.com', fromName: 'Maya Patel', receivedAt: hours(30),
      body: 'Hi, I would love to join. Call me on 07700 900123.\nMaya', attachments: [
        { name: 'Maya CV.pdf', contentType: 'application/pdf', size: 20000, isInline: false, data: pdf },
        { name: 'logo.png', contentType: 'image/png', size: 3000, isInline: true, data: 'aGk=' }] },
    { id: 'm2', subject: 'Any work?', from: 'tom@example.com', fromName: 'Tom Reed', receivedAt: hours(20), body: 'Looking for part-time work.' },
    { id: 'm3', subject: 'Automatic reply: hello', from: 'x@example.com', fromName: 'X', receivedAt: hours(10), body: 'Out of office' },
    { id: 'm4', subject: 'Old', from: 'old@example.com', fromName: 'Old', receivedAt: hours(24 * 40), body: 'Too old' },
  ], 'careers@cafe.example');
  server = createApp(db, { careers: box }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, data: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

test('helpers: phone numbers, CVs (not signature logos) and the template', () => {
  assert.equal(findPhone('ring 07700 900123 thanks'), '07700 900123');
  assert.equal(findPhone('+44 7700 900123'), '+44 7700 900123');
  assert.equal(findPhone('no number'), null);
  const kept = cvAttachments([
    { name: 'cv.docx', contentType: 'application/octet-stream', size: 30000, data: '' },
    { name: 'logo.png', contentType: 'image/png', size: 3000, isInline: false, data: '' },
    { name: 'photo.jpg', contentType: 'image/jpeg', size: 300000, isInline: true, data: '' },
    { name: 'run.exe', contentType: 'application/octet-stream', size: 3000, data: '' },
  ]);
  assert.deepEqual(kept.map((f) => f.name), ['cv.docx']);
  assert.equal(fillTemplate('Hi {first_name}, thanks for applying{job_as}.', { name: 'Maya Patel', job: 'Assistant manager' }), 'Hi Maya, thanks for applying as an Assistant manager.');
  assert.equal(fillTemplate('Your application{job_for}', { name: 'Tom', job: null }), 'Your application');
});

test('emails become candidates with their message and CV; automatic replies and old emails are left', async () => {
  const r = await checkCareers(db, { mailbox: box });
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  const maya = db.prepare(`SELECT * FROM candidates WHERE email = 'maya@example.com'`).get();
  assert.equal(maya.name, 'Maya Patel');
  assert.equal(maya.vacancy_id, jobId, 'matched to the open Barista job by its title');
  assert.equal(maya.phone, '07700 900123');
  assert.match(maya.message, /would love to join/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_files WHERE candidate_id = ?').get(maya.id).n, 1);
  const tom = db.prepare(`SELECT * FROM candidates WHERE email = 'tom@example.com'`).get();
  assert.equal(tom.vacancy_id, null);
  assert.ok(!db.prepare(`SELECT 1 FROM candidates WHERE email = 'old@example.com'`).get());
  // Checking again adds nothing; emailing again adds to the same profile.
  assert.equal((await checkCareers(db, { mailbox: box })).added, 0);
  box.messages.push({ id: 'm5', subject: 'Re: Application', from: 'MAYA@example.com', fromName: 'Maya', receivedAt: new Date().toISOString(), body: 'I forgot my reference letter.',
    attachments: [{ name: 'reference.pdf', contentType: 'application/pdf', size: 9000, data: pdf }] });
  await checkCareers(db, { mailbox: box });
  const again = db.prepare(`SELECT * FROM candidates WHERE lower(email) = 'maya@example.com'`).all();
  assert.equal(again.length, 1);
  assert.match(again[0].message, /forgot my reference/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_files WHERE candidate_id = ?').get(maya.id).n, 2);
});

test('the profile, its CV, moving on to interview and turning down with a draft reply', async () => {
  const a = await login('admin@cafe.local');
  const apps = (await a('/applications')).data;
  assert.equal(apps.new.length, 2);
  const maya = apps.new.find((c) => c.email === 'maya@example.com');
  const tom = apps.new.find((c) => c.email === 'tom@example.com');
  const p = (await a(`/candidates/${maya.id}`)).data;
  assert.equal(p.job_title, 'Barista');
  assert.equal(p.files.length, 2);
  assert.equal(p.can_draft_reply, true);
  assert.match(p.decline.body, /^Hi Maya,/);
  assert.match(p.decline.body, /as a Barista/);
  const file = await a(`/candidates/${maya.id}/files/${p.files[0].id}`);
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.data.toString(), '%PDF-1.4 a CV %%EOF');

  // Tom goes to interview for the Barista job.
  assert.equal((await a(`/candidates/${tom.id}`, { method: 'PUT', body: { stage: 'interview', vacancy_id: jobId, next_step_on: '2030-01-01' } })).status, 200);
  // Moved on without a job too: they're listed under In progress, not lost at the bottom.
  const tomNoJob = await a(`/candidates/${tom.id}`, { method: 'PUT', body: { stage: 'interview', vacancy_id: null } });
  assert.equal(tomNoJob.status, 200);
  assert.ok((await a('/applications')).data.in_progress.some((c) => c.id === tom.id && !c.job_title));
  assert.ok(!(await a('/applications')).data.no_job.some((c) => c.id === tom.id));
  await a(`/candidates/${tom.id}`, { method: 'PUT', body: { vacancy_id: jobId } });
  const t = db.prepare('SELECT stage, vacancy_id FROM candidates WHERE id = ?').get(tom.id);
  assert.deepEqual({ ...t }, { stage: 'interview', vacancy_id: jobId });

  // Maya is turned down: the reply is drafted in the careers inbox as a reply to her latest email.
  const d = await a(`/candidates/${maya.id}/decline`, { method: 'POST', body: { subject: 'Your application', body: 'Hi Maya, sorry.', draft: true } });
  assert.equal(d.data.draft, 'created');
  assert.deepEqual(box.drafts.at(-1), { id: 'm5', text: 'Hi Maya, sorry.' });
  const m = db.prepare('SELECT stage, declined_at, reply_drafted_at FROM candidates WHERE id = ?').get(maya.id);
  assert.equal(m.stage, 'rejected');
  assert.ok(m.declined_at && m.reply_drafted_at);
  assert.equal((await a('/applications')).data.new.length, 0);
});

test('the turn-down wording can be changed and put back', async () => {
  const a = await login('admin@cafe.local');
  await a('/careers-inbox/template', { method: 'PUT', body: { subject: 'Thanks{job_for}', body: 'Dear {name}, no thanks.' } });
  const c = db.prepare(`SELECT id FROM candidates WHERE email = 'tom@example.com'`).get();
  assert.equal((await a(`/candidates/${c.id}`)).data.decline.body, 'Dear Tom Reed, no thanks.');
  const st = (await a('/careers-inbox')).data;
  await a('/careers-inbox/template', { method: 'PUT', body: st.default_template });
  assert.match((await a(`/candidates/${c.id}`)).data.decline.body, /^Hi Tom,/);
});

test('a CV can be added by hand; staff can’t see candidates', async () => {
  const a = await login('admin@cafe.local');
  const c = db.prepare(`SELECT id FROM candidates WHERE email = 'tom@example.com'`).get();
  assert.equal((await a(`/candidates/${c.id}/files`, { method: 'POST', body: { file_name: 'cv.exe', data: pdf } })).status, 400);
  assert.equal((await a(`/candidates/${c.id}/files`, { method: 'POST', body: { file_name: 'Tom CV.pdf', data: pdf } })).status, 201);
  const s = await login('staff1@cafe.local');
  assert.equal((await s(`/candidates/${c.id}`)).status, 403);
  assert.equal((await s('/applications')).status, 403);
});

test('Microsoft 365: the careers inbox lists every email, reads its text and drafts replies', async () => {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers, body: init.body });
    if (String(url).includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
    if (String(url).includes('createReply')) return new Response(JSON.stringify({ id: 'D1', webLink: 'https://outlook.example/D1' }), { status: 201 });
    if (String(url).includes('$select=body')) return new Response(JSON.stringify({ body: { content: 'Hello there' } }), { status: 200 });
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  };
  const g = graphMailbox({ tenant: 't', clientId: 'c', secret: 's', address: 'careers@x.example' }, { fetchFn, withAttachmentsOnly: false, label: 'careers inbox' });
  await g.listNew('2026-01-02T00:00:00.000Z');
  assert.doesNotMatch(decodeURIComponent(seen[1].url.replace(/\+/g, ' ')), /hasAttachments eq true/);
  assert.equal(await g.body('M1'), 'Hello there');
  assert.equal(seen.find((x) => x.url.includes('$select=body')).headers.Prefer, 'outlook.body-content-type="text"');
  assert.deepEqual(await g.replyDraft('M1', 'Thanks'), { id: 'D1', webLink: 'https://outlook.example/D1' });
  const reply = seen.find((x) => x.url.includes('createReply'));
  assert.equal(reply.method, 'POST');
  assert.deepEqual(JSON.parse(reply.body), { comment: 'Thanks' });
  // Without permission to write, it says what to change.
  const noWrite = graphMailbox({ tenant: 't', clientId: 'c', secret: 's', address: 'careers@x.example' }, {
    fetchFn: async (url) => (String(url).includes('/oauth2/') ? new Response(JSON.stringify({ access_token: 'T' }), { status: 200 }) : new Response('{}', { status: 403 })),
    label: 'careers inbox' });
  await assert.rejects(noWrite.replyDraft('M1', 'x'), /Mail\.ReadWrite/);
});

test('a junk application can be deleted and isn’t added again', async () => {
  box.messages.push({ id: 'junk1', subject: 'Boost your SEO today!', from: 'spam@example.com', fromName: 'SEO Deals', receivedAt: new Date().toISOString(), body: 'Cheap backlinks' });
  await checkCareers(db, { mailbox: box });
  const junk = db.prepare(`SELECT id FROM candidates WHERE email = 'spam@example.com'`).get();
  const a = await login('admin@cafe.local');
  assert.ok((await a('/applications')).data.new.some((c) => c.id === junk.id));
  assert.equal((await a(`/candidates/${junk.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await a('/applications')).data.new.some((c) => c.id === junk.id));
  assert.equal((await checkCareers(db, { mailbox: box })).added, 0);
  assert.ok(!db.prepare(`SELECT 1 FROM candidates WHERE email = 'spam@example.com'`).get());
  assert.equal(db.prepare(`SELECT detail FROM careers_emails WHERE message_id = 'junk1'`).get().detail, 'Deleted in Atlas');
});
