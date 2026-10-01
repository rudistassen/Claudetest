// The shared invoice inbox: every few minutes, new emails with a PDF or photo attached are read by the invoice
// reader and added to Invoices for checking, just like an upload. Each email is only handled once.
import { requireAdmin, requirePerm } from './auth.js';
import { FILE_TYPES, fromBase64, MAX_INVOICE_BYTES, norm, saveReadInvoice } from './routes/invoices.js';
import { badRequest, notFound } from './util.js';
import { mailboxSetup } from './mailbox.js';

const KEY = { site: 'invoice_inbox_site', since: 'invoice_inbox_since', lastCheck: 'invoice_inbox_last_check', lastError: 'invoice_inbox_last_error' };
const MAX_ATTEMPTS = 3;
// Small pictures in emails are usually logos in someone's signature, not invoices.
const MIN_IMAGE_BYTES = 15 * 1024;

export const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (db, key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value === null ? null : String(value));

const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
function fileType(a) {
  const type = String(a.contentType ?? '').toLowerCase().split(';')[0].trim();
  if (FILE_TYPES.includes(type)) return type;
  return EXT_TYPES[String(a.name ?? '').toLowerCase().split('.').pop()] ?? null;
}

/** The attachments worth reading: PDFs and photos, not signature logos or other inline pictures. */
export function invoiceAttachments(list) {
  return list
    .map((a) => ({ ...a, type: fileType(a), bytes: a.size || Math.floor((a.data?.length ?? 0) * 0.75) }))
    .filter((a) => a.type && !a.isInline && a.bytes <= MAX_INVOICE_BYTES && (a.type === 'application/pdf' || a.bytes >= MIN_IMAGE_BYTES));
}

/**
 * Which site an emailed invoice is for: a site named in the subject, the start of the email or the addresses it
 * was sent to (the longest name wins, so "Buddy's Bakery" beats "Buddy's"); otherwise the inbox's default site.
 */
export function pickSite(db, message) {
  const sites = db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY id').all();
  const text = ` ${norm([message.subject, message.preview, ...(message.to ?? [])].join(' '))} `;
  const named = sites.filter((s) => norm(s.name) && text.includes(` ${norm(s.name)} `)).sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
  if (named) return named.id;
  const fallback = Number(getSetting(db, KEY.site));
  return sites.find((s) => s.id === fallback)?.id ?? sites[0]?.id ?? null;
}

async function handle(db, mailbox, reader, m) {
  const files = invoiceAttachments(await mailbox.attachments(m.id));
  if (!files.length) return { status: 'skipped', detail: 'No PDF or photo attached' };
  const locationId = pickSite(db, m);
  if (!locationId) return { status: 'failed', detail: 'Add a site first', permanent: true };
  const ids = [];
  const notes = [];
  for (const f of files) {
    const read = await reader.read({ media_type: f.type, data: f.data });
    if (read.is_invoice === false) { notes.push(`${f.name}: not an invoice`); continue; }
    const { invoiceId } = saveReadInvoice(db, {
      locationId, read, fileName: f.name.slice(0, 200), mediaType: f.type, bytes: fromBase64(f.data),
      email: { from: m.fromName ? `${m.fromName} <${m.from}>` : m.from, subject: m.subject?.slice(0, 300) ?? null },
    });
    ids.push(Number(invoiceId));
  }
  return ids.length ? { status: 'imported', ids, detail: notes.join('; ') || null } : { status: 'skipped', detail: notes.join('; ') || 'Nothing to import' };
}

let running = null;
/**
 * Checks the inbox once. The first time, it only notes the time, so older emails aren't imported; from then on
 * each new email is handled once (one that failed is tried again, up to 3 times).
 */
export function checkInbox(db, { mailbox, reader, now = new Date() }) {
  if (running) return running;
  running = (async () => {
    const summary = { checked: 0, imported: 0, invoices: 0, skipped: 0, failed: 0 };
    let since = getSetting(db, KEY.since);
    if (!since) {
      since = now.toISOString();
      setSetting(db, KEY.since, since);
    }
    try {
      const messages = await mailbox.listNew(since);
      const seen = db.prepare('SELECT status, attempts FROM invoice_emails WHERE message_id = ?');
      const save = db.prepare(`INSERT INTO invoice_emails (message_id, received_at, from_address, from_name, subject, status, invoice_ids, detail, attempts, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, invoice_ids = excluded.invoice_ids, detail = excluded.detail,
          attempts = excluded.attempts, processed_at = excluded.processed_at`);
      for (const m of messages) {
        const before = seen.get(m.id);
        if (before && (before.status !== 'failed' || before.attempts >= MAX_ATTEMPTS)) continue;
        summary.checked++;
        let result;
        try {
          result = await handle(db, mailbox, reader, m);
        } catch (err) {
          // A file the reader can't read won't improve on a retry; a busy or unreachable service might.
          const permanent = err.status === 400 || err.status === 422;
          result = { status: 'failed', detail: err.message, permanent };
        }
        const attempts = (before?.attempts ?? 0) + 1;
        save.run(m.id, m.receivedAt, m.from, m.fromName, m.subject, result.status, result.ids ? JSON.stringify(result.ids) : null, result.detail ?? null,
          result.permanent ? MAX_ATTEMPTS : attempts);
        summary[result.status === 'imported' ? 'imported' : result.status]++;
        summary.invoices += result.ids?.length ?? 0;
      }
      setSetting(db, KEY.lastError, null);
    } catch (err) {
      setSetting(db, KEY.lastError, err.message);
      summary.error = err.message;
    } finally {
      setSetting(db, KEY.lastCheck, now.toISOString());
    }
    return summary;
  })().finally(() => { running = null; });
  return running;
}

export function startInvoiceInbox(db, { mailbox, reader, minutes = 10, log = console }) {
  const run = async () => {
    const r = await checkInbox(db, { mailbox, reader });
    if (r.error) log.error(`Invoice inbox: ${r.error}`);
    else if (r.checked) log.log(`Invoice inbox: ${r.checked} email(s), ${r.invoices} invoice(s) added`);
  };
  setTimeout(run, 20000);
  return setInterval(run, minutes * 60000);
}

export function registerInvoiceInboxRoutes(router, db, { mailbox, reader }) {
  const status = () => ({
    configured: !!mailbox,
    ...(mailbox ? {} : { setup: mailboxSetup() }),
    mailbox: mailbox?.address ?? null,
    reader_ready: !!reader,
    since: getSetting(db, KEY.since),
    last_check: getSetting(db, KEY.lastCheck),
    last_error: getSetting(db, KEY.lastError),
    default_site_id: Number(getSetting(db, KEY.site)) || null,
    recent: db.prepare('SELECT * FROM invoice_emails ORDER BY COALESCE(received_at, processed_at) DESC LIMIT 25').all()
      .map((r) => ({ ...r, invoice_ids: r.invoice_ids ? JSON.parse(r.invoice_ids) : [] })),
  });
  router.get('/invoice-inbox', requirePerm('orders.manage'), (req, res) => res.json(status()));
  router.put('/invoice-inbox', requireAdmin, (req, res) => {
    const siteId = req.body.default_site_id ? Number(req.body.default_site_id) : null;
    if (siteId && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(siteId)) throw notFound('Site');
    setSetting(db, KEY.site, siteId);
    res.json(status());
  });
  router.post('/invoice-inbox/check', requirePerm('orders.manage'), async (req, res) => {
    if (!mailbox) throw badRequest('The invoice inbox isn’t connected yet');
    if (!reader) throw badRequest('Invoice reading isn’t switched on yet (ANTHROPIC_API_KEY)');
    const summary = await checkInbox(db, { mailbox, reader });
    res.json({ ...summary, ...status() });
  });
}
