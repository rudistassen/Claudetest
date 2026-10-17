import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { checkEvents } from '../src/events.js';
import { memoryMailbox } from '../src/mailbox.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

const hours = (h) => new Date(Date.now() - h * 3600000).toISOString();
// Reads "newsletter" emails as marketing, and "found somewhere" as needing no reply.
const reader = { calls: 0, async read({ emails }) {
  this.calls++;
  const text = emails.map((e) => e.body).join(' ');
  const marketing = /newsletter/i.test(text);
  return { kind: marketing ? 'marketing' : 'enquiry', kind_reason: marketing ? 'A newsletter' : 'Event', needs_reply: !marketing && !/found somewhere/i.test(emails.at(-1).body),
    title: null, event_type: null, event_date: null, start_time: null, end_time: null, guests: null, budget: null, contact_name: null, phone: null, site: null };
} };
let server; let base; let db; let box;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  box = memoryMailbox([
    { id: 'n1', conversationId: 'cn', subject: 'Our October newsletter', from: 'news@saas.example', fromName: 'SaaS Co', receivedAt: hours(50), body: 'Read our newsletter!' },
    { id: 'k1', conversationId: 'ck', subject: 'Xmas drinks', from: 'kate@example.com', fromName: 'Kate', receivedAt: hours(48), body: 'Space for 25 on 18 Dec?' },
    { id: 'k2', folder: 'sent', conversationId: 'ck', subject: 'Re: Xmas drinks', to: ['kate@example.com'], sentAt: hours(47), body: 'Yes we can!\n\nFrom: Kate\nSpace for 25 on 18 Dec?' },
    { id: 'h1', conversationId: 'ch', subject: 'Drinks 26th', from: 'holly@example.com', fromName: 'Holly', receivedAt: hours(30), body: 'Thanks, we have found somewhere else.' },
    { id: 'p1', conversationId: 'cp', subject: 'Party', from: 'pat@example.com', fromName: 'Pat', receivedAt: hours(20), body: 'Can I book for 30?' },
  ], 'events@cafe.example');
  server = createApp(db, { events: box, enquiryReader: reader }).listen(0);
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
const idOf = (email) => db.prepare('SELECT id FROM event_enquiries WHERE email = ?').get(email)?.id;

test('replies sent from Outlook join the conversation, and only real questions need a reply', async () => {
  const r = await checkEvents(db, { mailbox: box, reader });
  assert.equal(r.replies, 1);
  const kate = db.prepare(`SELECT direction, status, body FROM enquiry_messages WHERE enquiry_id = ? ORDER BY created_at`).all(idOf('kate@example.com'));
  assert.deepEqual(kate.map((m) => m.direction), ['in', 'out']);
  assert.equal(kate[1].body, 'Yes we can!', 'without the quoted email below it');
  const a = await login('admin@cafe.local');
  const s = (await a('/events/summary')).data;
  assert.deepEqual(s.needs_reply.map((e) => e.email), ['pat@example.com'], 'not the newsletter, not Kate (answered), not Holly (no reply needed)');
  assert.equal(s.counts.marketing, 1);
  // Sorting it out by hand, and back again.
  await a(`/events/enquiries/${idOf('pat@example.com')}/no-reply`, { method: 'POST', body: { no_reply_needed: true } });
  assert.equal((await a('/events/summary')).data.counts.needs_reply, 0);
  await a(`/events/enquiries/${idOf('pat@example.com')}/no-reply`, { method: 'POST', body: { no_reply_needed: false } });
  assert.equal((await a('/events/summary')).data.counts.needs_reply, 1);
  assert.equal((await checkEvents(db, { mailbox: box, reader })).replies, 0, 'each sent email once');
});

test('marketing: checked, then filed in the Marketing folder and deleted; the sender’s next email is filed too', async () => {
  const a = await login('admin@cafe.local');
  const c = (await a('/events/marketing/check', { method: 'POST' })).data;
  assert.deepEqual(c.marketing.map((e) => e.email), ['news@saas.example']);
  assert.equal(c.marketing[0].reason, 'A newsletter');
  const f = (await a('/events/marketing/file', { method: 'POST', body: { ids: c.marketing.map((e) => e.id) } })).data;
  assert.deepEqual([f.deleted, f.filed_in_outlook], [1, true]);
  assert.equal(box.messages.find((m) => m.id === 'n1').movedTo, 'Marketing');
  assert.equal(idOf('news@saas.example'), undefined);
  assert.deepEqual((await a('/events/marketing/senders')).data.map((s) => s.email), ['news@saas.example']);
  box.messages.push({ id: 'n2', subject: 'November newsletter', from: 'NEWS@saas.example', receivedAt: new Date().toISOString(), body: 'More news' });
  await checkEvents(db, { mailbox: box, reader });
  assert.equal(idOf('news@saas.example'), undefined);
  assert.equal(box.messages.find((m) => m.id === 'n2').movedTo, 'Marketing');
  await a(`/events/marketing/senders/${encodeURIComponent('news@saas.example')}`, { method: 'DELETE' });
  assert.equal((await a('/events/marketing/senders')).data.length, 0);
  const s = await login('staff1@cafe.local');
  assert.equal((await s('/events/marketing/check', { method: 'POST' })).status, 403);
});
