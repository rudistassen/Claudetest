import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { claudeEnquiryReader, ENQUIRY_SCHEMA } from '../src/enquiry-reader.js';
import { checkEvents, fillFromEmails } from '../src/events.js';
import { memoryMailbox } from '../src/mailbox.js';
import { seedDemo } from '../src/seed.js';

const fakeReader = (out, calls = []) => ({ async read(input) { calls.push(input); return { is_enquiry: true, title: null, event_type: null, event_date: null, start_time: null,
  end_time: null, guests: null, budget: null, contact_name: null, phone: null, site: null, ...out }; } });

test('a new enquiry’s details are filled in from the email, and marked to check', async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  const site = db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY id LIMIT 1').get();
  const box = memoryMailbox([{ id: 'm1', conversationId: 'c1', subject: 'Party enquiry', from: 'sam@example.com', fromName: 'Sam', receivedAt: new Date().toISOString(),
    body: 'Hi, 40 people on 14 Nov at 7pm, budget £1,500. 07700 900123' }], 'events@x.example');
  const calls = [];
  const reader = fakeReader({ title: 'Sam’s 40th', event_type: 'Birthday party', event_date: '2026-11-14', start_time: '19:00', end_time: 'late', guests: 40,
    budget: 1500, phone: '07700 900123', site: site.name.toUpperCase() }, calls);
  await checkEvents(db, { mailbox: box, reader });
  const e = db.prepare(`SELECT * FROM event_enquiries WHERE email = 'sam@example.com'`).get();
  assert.deepEqual([e.title, e.event_type, e.event_date, e.start_time, e.end_time, e.guests, e.budget, e.phone, e.location_id],
    ['Sam’s 40th', 'Birthday party', '2026-11-14', '19:00', null, 40, 1500, '07700 900123', site.id], 'a time that isn’t HH:MM is left out');
  assert.deepEqual(JSON.parse(e.filled_fields).sort(), ['budget', 'event_date', 'event_type', 'guests', 'location_id', 'phone', 'start_time', 'title']);
  assert.equal(calls[0].emails[0].body, 'Hi, 40 people on 14 Nov at 7pm, budget £1,500. 07700 900123');
  assert.ok(calls[0].sites.includes(site.name));
  assert.match(calls[0].today, /^\d{4}-\d{2}-\d{2}$/);
});

test('reading again never overwrites what someone has typed', async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  const id = Number(db.prepare(`INSERT INTO event_enquiries (title, name, email, guests, event_date) VALUES ('Wedding – Jones', 'Ann', 'ann@example.com', 80, '2027-06-01')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO enquiry_messages (enquiry_id, direction, subject, body) VALUES (?, 'in', 'Wedding', 'about 100 people, maybe 3pm')`).run(id);
  const filled = await fillFromEmails(db, fakeReader({ title: 'Ann’s wedding', guests: 100, event_date: '2027-06-02', start_time: '15:00' }), id);
  assert.deepEqual(filled, ['start_time']);
  const e = db.prepare('SELECT * FROM event_enquiries WHERE id = ?').get(id);
  assert.deepEqual([e.title, e.guests, e.event_date, e.start_time], ['Wedding – Jones', 80, '2027-06-01', '15:00']);
});

test('a reader that fails doesn’t stop the enquiry arriving', async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  const box = memoryMailbox([{ id: 'm1', subject: 'Hello', from: 'a@example.com', receivedAt: new Date().toISOString(), body: 'Hi' }], 'events@x.example');
  const r = await checkEvents(db, { mailbox: box, reader: { async read() { throw new Error('busy'); } } });
  assert.equal(r.added, 1);
  assert.ok(db.prepare(`SELECT 1 FROM event_enquiries WHERE email = 'a@example.com'`).get());
});

test('the Claude request: structured output, the emails, today and the venues', async () => {
  let sent;
  const client = { beta: { messages: { create: async (req) => { sent = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
    is_enquiry: true, title: 'Acme breakfast', event_type: 'Meeting', event_date: '', start_time: '08:00', end_time: '', guests: 15, budget: null, contact_name: 'Priya', phone: '', site: '' }) }] }; } } } };
  const out = await claudeEnquiryReader({ client }).read({ emails: [{ from: 'p@acme.example', subject: 'Breakfast', body: '15 people at 8am' }], sites: ['Harbour', 'High Street'], today: '2026-10-06' });
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.deepEqual(sent.output_config.format, { type: 'json_schema', schema: ENQUIRY_SCHEMA });
  assert.match(sent.system, /Today is 2026-10-06/);
  assert.match(sent.system, /Harbour; High Street/);
  assert.match(sent.messages[0].content, /15 people at 8am/);
  assert.deepEqual([out.title, out.guests, out.event_date, out.phone], ['Acme breakfast', 15, null, null], 'blanks come back as null');
  const refused = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(claudeEnquiryReader({ client: refused }).read({ emails: [], sites: [], today: '2026-10-06' }), /declined/);
});
