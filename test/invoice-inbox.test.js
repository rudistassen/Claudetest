import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { demoInvoiceReader } from '../src/invoice-demo.js';
import { checkInbox, getSetting, invoiceAttachments, pickSite, setSetting } from '../src/invoice-inbox.js';
import { graphMailbox, memoryMailbox } from '../src/mailbox.js';
import { HttpError } from '../src/util.js';

const fresh = () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  return db;
};
const pdf = { name: 'invoice.pdf', contentType: 'application/pdf', size: 40000, isInline: false, data: Buffer.from('%PDF-1.4 x').toString('base64') };
const mail = (id, receivedAt, extra = {}) => ({ id, subject: 'Invoice', from: 'a@supplier.example', fromName: 'Supplier', to: ['invoices@x.example'], receivedAt, preview: '', attachments: [pdf], ...extra });

test('the first check only starts the clock; after that each new email with an invoice is imported once', async () => {
  const db = fresh();
  const reader = demoInvoiceReader(db);
  const box = memoryMailbox([mail('old', '2026-01-01T09:00:00Z')]);
  const first = await checkInbox(db, { mailbox: box, reader, now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(first.checked, 0, 'emails from before it was switched on are left alone');
  assert.equal(getSetting(db, 'invoice_inbox_since'), '2026-01-02T00:00:00.000Z');

  box.messages.push(mail('new', '2026-01-02T10:00:00Z'));
  const before = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const second = await checkInbox(db, { mailbox: box, reader, now: new Date('2026-01-02T11:00:00Z') });
  assert.equal(second.imported, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before + 1);
  const inv = db.prepare(`SELECT source, email_from, email_subject, file_name FROM invoices ORDER BY id DESC LIMIT 1`).get();
  assert.deepEqual({ ...inv }, { source: 'email', email_from: 'Supplier <a@supplier.example>', email_subject: 'Invoice', file_name: 'invoice.pdf' });

  const third = await checkInbox(db, { mailbox: box, reader, now: new Date('2026-01-02T12:00:00Z') });
  assert.equal(third.checked, 0, 'not imported twice');
  assert.equal(getSetting(db, 'invoice_inbox_last_check'), '2026-01-02T12:00:00.000Z');
});

test('signature logos and other inline pictures are ignored; photos and PDFs are read', () => {
  const list = invoiceAttachments([
    { name: 'logo.png', contentType: 'image/png', size: 3000, isInline: true, data: 'x' },
    { name: 'tiny.jpg', contentType: 'image/jpeg', size: 5000, isInline: false, data: 'x' },
    { name: 'scan.JPG', contentType: 'application/octet-stream', size: 400000, isInline: false, data: 'x' },
    { name: 'terms.docx', contentType: 'application/msword', size: 30000, isInline: false, data: 'x' },
    pdf,
  ]);
  assert.deepEqual(list.map((a) => [a.name, a.type]), [['scan.JPG', 'image/jpeg'], ['invoice.pdf', 'application/pdf']]);
});

test('the site comes from the email when it names one (most specific first), else the default', () => {
  const db = fresh();
  const sites = db.prepare('SELECT id, name FROM locations ORDER BY id').all();
  db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Buddys', sites[0].id);
  db.prepare('UPDATE locations SET name = ? WHERE id = ?').run("Buddy's Bakery", sites[1].id);
  assert.equal(pickSite(db, { subject: 'Invoice for BUDDY’S BAKERY', to: [] }), pickSite(db, { subject: "buddy s bakery", to: [] }));
  assert.equal(pickSite(db, { subject: "Invoice – Buddy's Bakery", to: [] }), sites[1].id);
  assert.equal(pickSite(db, { subject: 'Invoice', preview: 'Delivered to Buddys today', to: [] }), sites[0].id);
  setSetting(db, 'invoice_inbox_site', sites[3].id);
  assert.equal(pickSite(db, { subject: 'Invoice 123', to: [] }), sites[3].id);
});

test('a busy reader is retried (up to 3 times); an unreadable file is not', async () => {
  const db = fresh();
  setSetting(db, 'invoice_inbox_since', '2026-01-01T00:00:00.000Z');
  let calls = 0;
  const busy = { read: async () => { calls++; throw new HttpError(503, 'The invoice reader is busy'); } };
  const box = memoryMailbox([mail('m1', '2026-01-01T10:00:00Z')]);
  for (let i = 0; i < 5; i++) await checkInbox(db, { mailbox: box, reader: busy });
  assert.equal(calls, 3);
  assert.equal(db.prepare('SELECT status, attempts FROM invoice_emails').get().status, 'failed');

  const unreadable = { read: async () => { calls++; throw new HttpError(422, 'Declined'); } };
  box.messages.push(mail('m2', '2026-01-01T11:00:00Z'));
  calls = 0;
  for (let i = 0; i < 3; i++) await checkInbox(db, { mailbox: box, reader: unreadable });
  assert.equal(calls, 1);
});

test('Microsoft 365: signs in, reads only new emails with attachments, and explains permission problems', async () => {
  const seen = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  let graphStatus = 200;
  const fetchFn = async (url, opts = {}) => {
    seen.push({ url: String(url), auth: opts.headers?.Authorization });
    if (String(url).includes('login.microsoftonline.com')) return reply(200, { access_token: 'tok', expires_in: 3600 });
    if (graphStatus !== 200) return reply(graphStatus, { error: { message: 'Access denied' } });
    if (String(url).includes('/attachments')) {
      return reply(200, { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentType: 'application/pdf', size: 10, isInline: false, contentBytes: 'QQ==' },
        { '@odata.type': '#microsoft.graph.itemAttachment', name: 'forwarded' }] });
    }
    return reply(200, { value: [{ id: 'M1', subject: 'Inv', from: { emailAddress: { address: 's@x.example', name: 'S' } }, toRecipients: [{ emailAddress: { address: 'invoices@x.example' } }], receivedDateTime: '2026-01-02T10:00:00Z', bodyPreview: 'hi' }] });
  };
  const box = graphMailbox({ tenant: 't1', clientId: 'c1', secret: 's1', address: 'invoices@x.example' }, { fetchFn });
  const list = await box.listNew('2026-01-02T00:00:00.000Z');
  assert.deepEqual(list, [{ id: 'M1', subject: 'Inv', from: 's@x.example', fromName: 'S', to: ['invoices@x.example'], receivedAt: '2026-01-02T10:00:00Z', preview: 'hi' }]);
  const graphUrl = decodeURIComponent(seen[1].url.replace(/\+/g, " "));
  assert.match(graphUrl, /users\/invoices@x\.example\/mailFolders\/inbox\/messages/);
  assert.match(graphUrl, /receivedDateTime ge 2026-01-02T00:00:00Z and hasAttachments eq true/);
  assert.equal(seen[1].auth, 'Bearer tok');
  assert.deepEqual((await box.attachments('M1')).map((a) => a.name), ['a.pdf'], 'only file attachments');
  assert.equal(seen.filter((s) => s.url.includes('login')).length, 1, 'the sign-in is reused');
  graphStatus = 403;
  await assert.rejects(box.listNew('2026-01-02T00:00:00Z'), /Mail\.Read application permission/);
});

test('while the inbox is not connected, Brewly says which settings it can and can’t see (names only)', async () => {
  const { mailboxSetup } = await import('../src/mailbox.js');
  const setup = mailboxSetup({ MS_TENANT_ID: 'abc', 'MS_CLIENT_ID ': 'def', ms_client_secret: 'secret!', INVOICE_MAILBOX: '  ' });
  assert.deepEqual(setup, [
    { name: 'MS_TENANT_ID', status: 'ok' },
    { name: 'MS_CLIENT_ID', status: 'misnamed', found: 'MS_CLIENT_ID ' },
    { name: 'MS_CLIENT_SECRET', status: 'misnamed', found: 'ms_client_secret' },
    { name: 'INVOICE_MAILBOX', status: 'empty' },
  ]);
  assert.ok(!JSON.stringify(setup).includes('secret!'), 'values are never included');
});
