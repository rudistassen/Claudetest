import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { checkEvents } from '../src/events.js';
import { graphMailbox, memoryMailbox } from '../src/mailbox.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

const hours = (h) => new Date(Date.now() - h * 3600000).toISOString();
let server;
let base;
let db;
let box;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const site = db.prepare('SELECT name FROM locations WHERE active = 1 ORDER BY id LIMIT 1').get().name;
  box = memoryMailbox([
    { id: 'e1', conversationId: 'c1', subject: `Birthday party at ${site}`, from: 'sarah@example.com', fromName: 'Sarah Jones', receivedAt: hours(30), body: 'Hi, 40 people on 14 Nov?',
      attachments: [{ name: 'ideas.pdf', contentType: 'application/pdf', size: 20000, data: Buffer.from('%PDF x').toString('base64') }] },
    { id: 'e2', conversationId: 'c2', subject: 'Breakfast meeting', from: 'priya@acme.example', fromName: 'Priya', receivedAt: hours(20), body: '15 people, a screen please.' },
    { id: 'e3', conversationId: 'c1', subject: 'Re: Birthday party', from: 'sarah@example.com', fromName: 'Sarah Jones', receivedAt: hours(10), body: 'Some guests are vegan.' },
    { id: 'e4', subject: 'Automatic reply: hello', from: 'x@example.com', receivedAt: hours(5), body: 'Away' },
  ], 'events@cafe.example');
  server = createApp(db, { events: box }).listen(0);
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

test('emails become enquiries, and replies in the same thread join them', async () => {
  const r = await checkEvents(db, { mailbox: box });
  assert.deepEqual([r.added, r.skipped], [3, 1]);
  const a = await login('admin@cafe.local');
  const list = (await a('/events/enquiries')).data;
  assert.equal(list.length, 2);
  const sarah = list.find((e) => e.email === 'sarah@example.com');
  assert.equal(sarah.title, 'Birthday party at ' + db.prepare('SELECT name FROM locations WHERE active = 1 ORDER BY id LIMIT 1').get().name);
  assert.ok(sarah.location_id, 'the site named in the subject');
  assert.equal(sarah.unread, 1);
  assert.equal(sarah.message_count, 2);
  assert.equal((await a('/events/unread')).data.count, 2);
  const full = (await a(`/events/enquiries/${sarah.id}`)).data;
  assert.deepEqual(full.messages.map((m) => m.body), ['Hi, 40 people on 14 Nov?', 'Some guests are vegan.']);
  assert.equal(full.files.length, 1);
  assert.equal((await a('/events/unread')).data.count, 1, 'opening it marks it read');
  assert.equal((await checkEvents(db, { mailbox: box })).added, 0, 'each email once');
});

test('replying sends from the events inbox in their thread; notes stay in Atlas', async () => {
  const a = await login('admin@cafe.local');
  const sarah = db.prepare(`SELECT id FROM event_enquiries WHERE email = 'sarah@example.com'`).get();
  assert.equal((await a(`/events/enquiries/${sarah.id}/messages`, { method: 'POST', body: { kind: 'note', body: 'Check the vegan menu with the kitchen' } })).status, 201);
  assert.equal(box.sent.length, 0);
  const r = await a(`/events/enquiries/${sarah.id}/messages`, { method: 'POST', body: { kind: 'email', body: 'Hi Sarah, yes – we can do that!' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(box.sent.at(-1), { reply_to: 'e3', text: 'Hi Sarah, yes – we can do that!' }, 'a reply to their latest email');
  const e = (await a(`/events/enquiries/${sarah.id}`)).data;
  assert.equal(e.status, 'replied');
  assert.deepEqual(e.messages.map((m) => m.direction), ['in', 'in', 'note', 'out']);
  // A new enquiry added by hand gets a new email.
  const made = (await a('/events/enquiries', { method: 'POST', body: { name: 'Tom', email: 'tom@example.com', title: 'Wake', status: 'new' } })).data;
  await a(`/events/enquiries/${made.id}/messages`, { method: 'POST', body: { kind: 'email', body: 'Hello Tom', subject: 'Your enquiry' } });
  assert.deepEqual(box.sent.at(-1), { to: 'tom@example.com', subject: 'Your enquiry', text: 'Hello Tom' });
});

test('the calendar shows dated events that aren’t lost', async () => {
  const a = await login('admin@cafe.local');
  const add = async (body) => (await a('/events/enquiries', { method: 'POST', body: { name: 'X', ...body } })).data.id;
  const yes = await add({ title: 'Wedding', event_date: '2030-06-14', start_time: '14:00', status: 'confirmed', guests: 80 });
  const maybe = await add({ title: 'Party', event_date: '2030-06-20', status: 'provisional' });
  await add({ title: 'Lost one', event_date: '2030-06-21', status: 'lost' });
  await add({ title: 'Other month', event_date: '2030-07-01', status: 'confirmed' });
  const cal = (await a('/events/calendar?from=2030-06-01&to=2030-06-30')).data;
  assert.deepEqual(cal.map((e) => e.id), [yes, maybe]);
  assert.equal((await a('/events/enquiries', { method: 'POST', body: { name: 'Y', start_time: '25:00' } })).status, 400);
  assert.equal((await a('/events/calendar?from=2030-06-01')).status, 400);
});

test('staff can’t see events', async () => {
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/events/enquiries')).status, 403);
});

test('Microsoft 365: replies and new emails, and what to change without permission to send', async () => {
  const seen = [];
  const ok = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    if (String(url).includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
    return new Response('', { status: 202 });
  };
  const g = graphMailbox({ tenant: 't', clientId: 'c', secret: 's', address: 'events@x.example' }, { fetchFn: ok, withAttachmentsOnly: false, label: 'events inbox' });
  await g.reply('M1', 'Thanks!');
  assert.match(seen.at(-1).url, /users\/events%40x\.example\/messages\/M1\/reply$/);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { comment: 'Thanks!' });
  await g.send({ to: 'a@b.example', subject: 'Hi', text: 'Hello' });
  assert.match(seen.at(-1).url, /sendMail$/);
  assert.equal(JSON.parse(seen.at(-1).body).message.toRecipients[0].emailAddress.address, 'a@b.example');
  const no = graphMailbox({ tenant: 't', clientId: 'c', secret: 's', address: 'events@x.example' }, {
    fetchFn: async (url) => (String(url).includes('/oauth2/') ? new Response(JSON.stringify({ access_token: 'T' }), { status: 200 }) : new Response('{}', { status: 403 })),
    label: 'events inbox' });
  await assert.rejects(no.reply('M1', 'x'), /Mail\.Send/);
});

test('the summary: who needs a reply (oldest first), and the next fortnight', async () => {
  const a = await login('admin@cafe.local');
  const s = (await a('/events/summary')).data;
  // Sarah has been replied to; Priya's email is still waiting.
  assert.deepEqual(s.needs_reply.map((e) => e.email), ['priya@acme.example']);
  assert.equal(s.counts.needs_reply, 1);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const id = (await a('/events/enquiries', { method: 'POST', body: { name: 'Soon', title: 'Soon party', event_date: soon, status: 'confirmed' } })).data.id;
  const s2 = (await a('/events/summary')).data;
  assert.ok(s2.upcoming.some((e) => e.id === id));
  assert.ok(s2.counts.confirmed_ahead >= 1);
  // A note doesn't count as a reply.
  const priya = db.prepare(`SELECT id FROM event_enquiries WHERE email = 'priya@acme.example'`).get().id;
  await a(`/events/enquiries/${priya}/messages`, { method: 'POST', body: { kind: 'note', body: 'Check the screen' } });
  assert.equal((await a('/events/summary')).data.counts.needs_reply, 1);
  await a(`/events/enquiries/${priya}/messages`, { method: 'POST', body: { kind: 'email', body: 'Yes we can!' } });
  assert.equal((await a('/events/summary')).data.counts.needs_reply, 0);
});
