// Events: enquiries from the shared events inbox (or added by hand), the conversation about each one – emails in
// and out, sent from the events inbox so replies stay in the customer's thread – and the events calendar.
import { requirePerm } from './auth.js';
import { cvAttachments } from './careers-inbox.js';
import { tx } from './db.js';
import { getSetting, setSetting } from './invoice-inbox.js';
import { EVENTS_VARIABLES, mailboxSetup } from './mailbox.js';
import { fromBase64 } from './routes/invoices.js';
import { badRequest, date, HttpError, id, notFound, num, oneOf, str, time, today } from './util.js';
import { notify, peopleWith } from './push.js';

const KEY = { since: 'events_inbox_since', sentSince: 'events_inbox_sent_since', lastCheck: 'events_inbox_last_check', lastError: 'events_inbox_last_error' };
export const MARKETING_FOLDER = 'Marketing';
const MAX_ATTEMPTS = 3;
const FIRST_DAYS = 14;
export const STATUSES = ['new', 'replied', 'provisional', 'confirmed', 'completed', 'lost'];

const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|out of (the )?office|undeliverable|delivery (status|has failed)|mail delivery|returned mail|read:)/i;
const AUTO_SENDER = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster)/i;
const norm = (t) => String(t ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanSubject = (s) => String(s ?? '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
const cleanBody = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 30000);
// Graph's times (2026-10-06T10:00:00Z) as SQLite keeps them (2026-10-06 10:00:00, UTC).
const sqlTime = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : null);

function pickSite(db, text) {
  const t = ` ${norm(text)} `;
  return db.prepare('SELECT id, name FROM locations WHERE active = 1').all()
    .filter((s) => norm(s.name) && t.includes(` ${norm(s.name)} `))
    .sort((a, b) => norm(b.name).length - norm(a.name).length)[0]?.id ?? null;
}

async function handle(db, mailbox, m) {
  const from = String(m.from ?? '').trim();
  if (!from) return { status: 'skipped', detail: 'No sender' };
  if (from.toLowerCase() === String(mailbox.address).toLowerCase()) return { status: 'skipped', detail: 'Sent from the events inbox itself' };
  if (AUTO_SUBJECT.test(m.subject ?? '') || AUTO_SENDER.test(from)) return { status: 'skipped', detail: 'An automatic email' };
  // A sender filed as marketing before: filed again, straight away.
  if (db.prepare('SELECT 1 FROM events_marketing_senders WHERE email = ?').get(from)) {
    try { await mailbox.moveToFolder?.([m.id], MARKETING_FOLDER); } catch { /* left in the inbox – it's still not an enquiry */ }
    return { status: 'skipped', detail: 'From a marketing sender – filed' };
  }
  const body = cleanBody(await mailbox.body(m.id));
  const files = cvAttachments(m.hasAttachments === false ? [] : await mailbox.attachments(m.id));
  const out = tx(db, () => {
    // The enquiry it belongs to: the same email thread, else the same person's open enquiry.
    let enquiry = m.conversationId ? db.prepare('SELECT id FROM event_enquiries WHERE conversation_id = ?').get(m.conversationId) : null;
    enquiry ??= db.prepare(`SELECT id FROM event_enquiries WHERE lower(email) = lower(?) AND status IN ('new', 'replied', 'provisional', 'confirmed')
      AND created_at >= datetime('now', '-180 days') ORDER BY id DESC LIMIT 1`).get(from);
    let enquiryId = enquiry?.id;
    if (!enquiryId) {
      const name = (m.fromName && !m.fromName.includes('@') ? m.fromName : from.split('@')[0].replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).slice(0, 100);
      enquiryId = Number(db.prepare(`INSERT INTO event_enquiries (location_id, title, name, email, source, conversation_id, unread, last_message_at)
        VALUES (?, ?, ?, ?, 'email', ?, 1, ?)`).run(pickSite(db, `${m.subject} ${body.slice(0, 800)}`), cleanSubject(m.subject).slice(0, 200) || null, name,
        from.slice(0, 200), m.conversationId ?? null, sqlTime(m.receivedAt) ?? sqlTime(new Date().toISOString())).lastInsertRowid);
    } else {
      db.prepare(`UPDATE event_enquiries SET unread = 1, no_reply_needed = 0, last_message_at = ?, conversation_id = COALESCE(conversation_id, ?), updated_at = datetime('now') WHERE id = ?`)
        .run(sqlTime(m.receivedAt) ?? sqlTime(new Date().toISOString()), m.conversationId ?? null, enquiryId);
    }
    const msgId = Number(db.prepare(`INSERT INTO enquiry_messages (enquiry_id, direction, from_address, from_name, to_address, subject, body, email_message_id, created_at)
      VALUES (?, 'in', ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(enquiryId, from.slice(0, 200), m.fromName ?? null, mailbox.address,
      (m.subject ?? '').slice(0, 300), body || null, m.id, sqlTime(m.receivedAt)).lastInsertRowid);
    const addFile = db.prepare('INSERT INTO enquiry_files (enquiry_id, message_id, file_name, file_type, size, file) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of files) addFile.run(enquiryId, msgId, String(f.name).slice(0, 200), f.type, f.bytes, fromBase64(f.data));
    return { status: 'added', enquiryId, isNew: !enquiry, detail: enquiry ? 'Added to an existing enquiry' : null };
  });
  // A new enquiry: whoever manages events (at its site, if one was picked) gets a notification.
  if (out.isNew) {
    const site = db.prepare('SELECT location_id, name, title FROM event_enquiries WHERE id = ?').get(out.enquiryId);
    notify(db, peopleWith(db, ['events.manage'], site?.location_id ?? null), 'enquiry',
      { title: 'New events enquiry', body: `${site?.name ?? from}${site?.title ? ` – ${site.title}` : ''}`, url: `/#/events/enquiries/${out.enquiryId}`, tag: `enquiry-${out.enquiryId}` });
  }
  return out;
}

// The details read from an enquiry's emails, as they're saved (anything not in the right form is left out).
const DETAIL_FIELDS = ['title', 'event_type', 'event_date', 'start_time', 'end_time', 'guests', 'budget', 'phone', 'location_id'];
function readDetails(db, out) {
  const site = out.site ? db.prepare('SELECT id FROM locations WHERE active = 1 AND lower(name) = lower(?)').get(out.site) : null;
  const ok = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  return {
    title: out.title ? String(out.title).slice(0, 200) : null,
    event_type: out.event_type ? String(out.event_type).slice(0, 100) : null,
    event_date: ok(out.event_date, /^\d{4}-\d{2}-\d{2}$/),
    start_time: ok(out.start_time, /^([01]\d|2[0-3]):[0-5]\d$/),
    end_time: ok(out.end_time, /^([01]\d|2[0-3]):[0-5]\d$/),
    guests: Number.isInteger(out.guests) && out.guests > 0 && out.guests < 100000 ? out.guests : null,
    budget: typeof out.budget === 'number' && out.budget > 0 ? out.budget : null,
    phone: out.phone ? String(out.phone).slice(0, 50) : null,
    location_id: site?.id ?? null,
  };
}

/**
 * Reads an enquiry's emails and fills in the details it doesn't have yet – never changing what's there (so nothing
 * someone has typed is overwritten). The title read from the email replaces one that's just the email's subject.
 * Returns the fields filled.
 */
export async function fillFromEmails(db, reader, enquiryId) {
  const e = db.prepare('SELECT * FROM event_enquiries WHERE id = ?').get(enquiryId);
  if (!e) return [];
  const emails = db.prepare(`SELECT direction, from_address AS "from", created_at AS at, subject, body FROM enquiry_messages WHERE enquiry_id = ? AND direction != 'note'
    ORDER BY created_at DESC, id DESC LIMIT 12`).all(e.id).reverse();
  if (!emails.some((m) => m.direction === 'in')) return [];
  const sites = db.prepare('SELECT name FROM locations WHERE active = 1 ORDER BY name').all().map((l) => l.name);
  const out = await reader.read({ emails, sites, today: today() });
  // What it is, and whether a reply is owed (the reader only ever clears that; a new email from them sets it again).
  db.prepare(`UPDATE event_enquiries SET ai_kind = ?, ai_reason = ?, no_reply_needed = CASE WHEN ? THEN 1 ELSE no_reply_needed END WHERE id = ?`)
    .run(['enquiry', 'marketing', 'other'].includes(out.kind) ? out.kind : null, out.kind_reason ? String(out.kind_reason).slice(0, 200) : null,
      out.needs_reply === false ? 1 : 0, e.id);
  if (out.kind === 'marketing') return [];
  const found = readDetails(db, out);
  const subjectTitle = !e.title || e.title === cleanSubject(emails.find((m) => m.direction === 'in').subject).slice(0, 200);
  const filled = DETAIL_FIELDS.filter((k) => found[k] !== null && (k === 'title' ? subjectTitle && found.title !== e.title : e[k] === null || e[k] === undefined));
  if (!filled.length) return [];
  const before = (() => { try { return JSON.parse(e.filled_fields ?? '[]'); } catch { return []; } })();
  db.prepare(`UPDATE event_enquiries SET ${filled.map((k) => `${k} = ?`).join(', ')}, filled_fields = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(...filled.map((k) => found[k]), JSON.stringify([...new Set([...before, ...filled])]), e.id);
  return filled;
}

let running = null;
/** Checks the inbox once (the first time, bringing in the last fortnight's emails). */
export function checkEvents(db, { mailbox, reader = null, now = new Date() }) {
  if (running) return running;
  running = (async () => {
    const summary = { checked: 0, added: 0, skipped: 0, failed: 0 };
    let since = getSetting(db, KEY.since);
    if (!since) {
      since = new Date(now.getTime() - FIRST_DAYS * 86400000).toISOString();
      setSetting(db, KEY.since, since);
    }
    try {
      const messages = await mailbox.listNew(since);
      const seen = db.prepare('SELECT status, attempts FROM events_emails WHERE message_id = ?');
      const save = db.prepare(`INSERT INTO events_emails (message_id, received_at, from_address, subject, status, enquiry_id, detail, attempts, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, enquiry_id = excluded.enquiry_id, detail = excluded.detail,
          attempts = excluded.attempts, processed_at = excluded.processed_at`);
      for (const m of messages) {
        const before = seen.get(m.id);
        if (before && (before.status !== 'failed' || before.attempts >= MAX_ATTEMPTS)) continue;
        summary.checked++;
        let result;
        try { result = await handle(db, mailbox, m); } catch (err) { result = { status: 'failed', detail: err.message }; }
        // Fill in the details from the email; if that doesn't work the enquiry is still there to fill in by hand.
        if (result.status === 'added' && reader) {
          try { await fillFromEmails(db, reader, result.enquiryId); } catch (err) { console.error(`Events inbox: couldn’t read the details from an email: ${err.message}`); }
        }
        save.run(m.id, m.receivedAt ?? null, m.from ?? null, m.subject ?? null, result.status, result.enquiryId ?? null, result.detail ?? null, (before?.attempts ?? 0) + 1);
        summary[result.status]++;
      }
      // Replies sent from the inbox in Outlook, so the conversation here is complete and nobody's shown as waiting.
      if (mailbox.listSent) summary.replies = await syncSent(db, mailbox, getSetting(db, KEY.sentSince) ?? since, now);
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

// The reply someone wrote, without the earlier emails Outlook quotes beneath it.
const ownPart = (t) => cleanBody(String(t ?? '').split(/\n\s*(?:From:\s|-{3,}\s*Original Message|On .{5,80} wrote:|_{10,})/i)[0]);

/** Adds emails sent from the inbox (in Outlook) to their enquiry's conversation. Returns how many were added. */
async function syncSent(db, mailbox, since, now) {
  let added = 0;
  for (const m of await mailbox.listSent(since)) {
    if (!m.conversationId || db.prepare('SELECT 1 FROM enquiry_messages WHERE email_message_id = ?').get(m.id)) continue;
    const e = db.prepare('SELECT id FROM event_enquiries WHERE conversation_id = ?').get(m.conversationId);
    if (!e) continue;
    const at = sqlTime(m.sentAt);
    // One Atlas sent itself (it's in Sent Items too): just note which email it was.
    const own = db.prepare(`SELECT id FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'out' AND status = 'sent' AND email_message_id IS NULL
      AND abs(strftime('%s', created_at) - strftime('%s', ?)) <= 900 ORDER BY id LIMIT 1`).get(e.id, at);
    if (own) {
      db.prepare('UPDATE enquiry_messages SET email_message_id = ? WHERE id = ?').run(m.id, own.id);
      continue;
    }
    const body = ownPart(await mailbox.body(m.id));
    tx(db, () => {
      db.prepare(`INSERT INTO enquiry_messages (enquiry_id, direction, from_address, to_address, subject, body, email_message_id, status, created_at)
        VALUES (?, 'out', ?, ?, ?, ?, ?, 'logged', ?)`).run(e.id, mailbox.address, m.to?.[0] ?? null, (m.subject ?? '').slice(0, 300), body || null, m.id, at);
      db.prepare(`UPDATE event_enquiries SET status = CASE WHEN status = 'new' THEN 'replied' ELSE status END,
        last_message_at = max(COALESCE(last_message_at, ''), ?), updated_at = datetime('now') WHERE id = ?`).run(at, e.id);
    });
    added++;
  }
  setSetting(db, KEY.sentSince, now.toISOString());
  return added;
}

export function startEventsInbox(db, { mailbox, reader = null, minutes = 5, log = console }) {
  const run = async () => {
    const r = await checkEvents(db, { mailbox, reader });
    if (r.error) log.error(`Events inbox: ${r.error}`);
    else if (r.added) log.log(`Events inbox: ${r.added} email(s) added`);
  };
  setTimeout(run, 40000);
  return setInterval(run, minutes * 60000);
}

export function registerEventRoutes(router, db, { mailbox = null, reader = null } = {}) {
  const perm = requirePerm('events.manage');
  const canSee = (req, e) => !e.location_id || req.user.site_ids.includes(e.location_id);
  const enquiry = (req, eid) => {
    const e = db.prepare('SELECT * FROM event_enquiries WHERE id = ?').get(eid);
    if (!e || !canSee(req, e)) throw notFound('Enquiry');
    return e;
  };
  const status = () => ({
    configured: !!mailbox,
    ...(mailbox ? {} : { setup: mailboxSetup(globalThis.process?.env ?? {}, EVENTS_VARIABLES) }),
    mailbox: mailbox?.address ?? null,
    last_check: getSetting(db, KEY.lastCheck),
    last_error: getSetting(db, KEY.lastError),
    marketing_senders: db.prepare('SELECT COUNT(*) AS n FROM events_marketing_senders').get().n,
  });

  router.get('/events/inbox', perm, (_req, res) => res.json(status()));
  router.post('/events/inbox/check', perm, async (_req, res) => {
    if (!mailbox) throw badRequest('The events inbox isn’t connected yet');
    res.json({ ...(await checkEvents(db, { mailbox, reader })), ...status() });
  });

  // The summary at the top of Enquiries: enquiries waiting for a reply (their latest email is from the customer,
  // oldest waiting first), the next fortnight's events, and a few counts. ?location_id narrows it to one site.
  router.get('/events/summary', perm, (req, res) => {
    const site = id(req.query.location_id, 'location_id');
    const mine = (e) => canSee(req, e) && (!site || e.location_id === site);
    const waiting = db.prepare(`SELECT e.id, e.title, e.name, e.email, e.status, e.event_date, e.guests, e.location_id, e.unread, l.name AS location_name,
        m.created_at AS waiting_since, substr(COALESCE(m.body, ''), 1, 200) AS last_text
      FROM event_enquiries e
      JOIN enquiry_messages m ON m.id = (SELECT m2.id FROM enquiry_messages m2 WHERE m2.enquiry_id = e.id AND m2.direction != 'note' ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1)
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE m.direction = 'in' AND e.status NOT IN ('completed', 'lost') AND e.no_reply_needed = 0 AND COALESCE(e.ai_kind, '') != 'marketing'
      ORDER BY m.created_at, e.id`).all().filter(mine);
    const upcoming = db.prepare(`SELECT e.id, e.title, e.name, e.status, e.event_date, e.start_time, e.end_time, e.guests, e.location_id, l.name AS location_name
      FROM event_enquiries e LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.event_date BETWEEN date('now') AND date('now', '+13 days') AND e.status IN ('provisional', 'confirmed')
      ORDER BY e.event_date, COALESCE(e.start_time, '99:99')`).all().filter(mine);
    const count = (sql) => db.prepare(`SELECT location_id FROM event_enquiries WHERE ${sql}`).all().filter(mine).length;
    res.json({
      needs_reply: waiting,
      upcoming,
      counts: {
        needs_reply: waiting.length,
        new_this_week: count(`created_at >= datetime('now', '-7 days')`),
        provisional: count(`status = 'provisional'`),
        confirmed_ahead: count(`status = 'confirmed' AND event_date >= date('now')`),
        marketing: count(`ai_kind = 'marketing' AND status IN ('new', 'replied')`),
      },
      can_check_marketing: !!reader,
    });
  });

  // Someone has decided this one doesn't need a reply (or does after all). { no_reply_needed: true | false }
  router.post('/events/enquiries/:id/no-reply', perm, (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    db.prepare('UPDATE event_enquiries SET no_reply_needed = ?, unread = 0 WHERE id = ?').run(req.body?.no_reply_needed === false ? 0 : 1, e.id);
    res.json({ ok: true });
  });

  // Marketing: enquiries nobody has answered are read (any not read yet) and those that look like marketing listed,
  // with why, to be filed and deleted (below).
  const unanswered = (req) => db.prepare(`SELECT e.* FROM event_enquiries e WHERE e.source = 'email' AND e.status IN ('new', 'replied')
      AND NOT EXISTS (SELECT 1 FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction = 'out')
    ORDER BY e.id`).all().filter((e) => canSee(req, e));
  router.post('/events/marketing/check', perm, async (req, res) => {
    if (!reader) throw badRequest('Checking emails needs ANTHROPIC_API_KEY (the same key as the invoice reader)');
    const todo = unanswered(req).filter((e) => !e.ai_kind).slice(0, 40);
    let failed = 0;
    // A few at a time, to keep it quick without overloading the reader.
    for (let i = 0; i < todo.length; i += 4) {
      const results = await Promise.allSettled(todo.slice(i, i + 4).map((e) => fillFromEmails(db, reader, e.id)));
      failed += results.filter((r) => r.status === 'rejected').length;
    }
    const list = unanswered(req).filter((e) => e.ai_kind === 'marketing').map((e) => ({
      id: e.id, name: e.name, email: e.email, title: e.title, reason: e.ai_reason,
      preview: db.prepare(`SELECT substr(COALESCE(body, ''), 1, 160) AS t FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1`).get(e.id)?.t ?? '',
    }));
    res.json({ checked: todo.length, failed, marketing: list, more: unanswered(req).some((e) => !e.ai_kind) });
  });

  // { ids }: their emails are moved to the events inbox's Marketing folder, the senders remembered (so later emails
  // from them are filed straight away), and the enquiries deleted from Atlas.
  router.post('/events/marketing/file', perm, async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((v) => id(v, 'id', { required: true }));
    if (!ids.length) throw badRequest('Tick the emails to file');
    const list = ids.map((i) => enquiry(req, i));
    const emailIds = list.flatMap((e) => db.prepare(`SELECT email_message_id FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' AND email_message_id IS NOT NULL`)
      .all(e.id).map((m) => m.email_message_id));
    let outlook = null;
    if (mailbox?.moveToFolder && emailIds.length) {
      try { await mailbox.moveToFolder(emailIds, MARKETING_FOLDER); outlook = 'filed'; } catch (err) { outlook = err.message; }
    }
    tx(db, () => {
      for (const e of list) {
        if (e.email) db.prepare('INSERT OR IGNORE INTO events_marketing_senders (email) VALUES (?)').run(e.email.toLowerCase());
        db.prepare('DELETE FROM event_enquiries WHERE id = ?').run(e.id);
      }
    });
    res.json({ deleted: list.length, filed_in_outlook: outlook === 'filed', outlook_error: outlook && outlook !== 'filed' ? outlook : null, folder: MARKETING_FOLDER });
  });

  router.get('/events/marketing/senders', perm, (_req, res) => {
    res.json(db.prepare('SELECT email, filed_at FROM events_marketing_senders ORDER BY email').all());
  });
  router.delete('/events/marketing/senders/:email', perm, (req, res) => {
    db.prepare('DELETE FROM events_marketing_senders WHERE email = ?').run(String(req.params.email));
    res.json({ ok: true });
  });

  router.get('/events/unread', perm, (req, res) => {
    const rows = db.prepare(`SELECT location_id FROM event_enquiries WHERE unread = 1`).all();
    res.json({ count: rows.filter((e) => canSee(req, e)).length });
  });

  // ?show=open (default) | confirmed | closed | all, and location_id.
  router.get('/events/enquiries', perm, (req, res) => {
    const show = ['open', 'confirmed', 'closed', 'all'].includes(req.query.show) ? req.query.show : 'open';
    const where = { open: `e.status IN ('new', 'replied', 'provisional')`, confirmed: `e.status = 'confirmed'`, closed: `e.status IN ('completed', 'lost')`, all: '1' }[show];
    const site = id(req.query.location_id, 'location_id');
    const rows = db.prepare(`SELECT e.*, l.name AS location_name, u.name AS assigned_name,
        (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction != 'note') AS message_count,
        (SELECT substr(COALESCE(m.body, ''), 1, 200) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction != 'note' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
        (SELECT m.direction FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction != 'note' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_direction
      FROM event_enquiries e LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN users u ON u.id = e.assigned_to
      WHERE ${where} ${site ? 'AND e.location_id = ?' : ''}
      ORDER BY e.unread DESC, COALESCE(e.last_message_at, e.created_at) DESC, e.id DESC`).all(...(site ? [site] : []));
    res.json(rows.filter((e) => canSee(req, e)));
  });

  const fields = (b, old = {}) => {
    const v = { ...old, ...b };
    const f = {
      title: str(v.title, 'Title', { max: 200 }),
      name: str(v.name, 'Name', { required: true, max: 100 }),
      email: str(v.email, 'Email', { max: 200 }),
      phone: str(v.phone, 'Phone', { max: 50 }),
      location_id: id(v.location_id, 'Site'),
      event_type: str(v.event_type, 'Type of event', { max: 100 }),
      event_date: date(v.event_date, 'Date'),
      start_time: time(v.start_time, 'Start time'),
      end_time: time(v.end_time, 'End time'),
      guests: num(v.guests, 'Guests', { int: true, min: 0, max: 100000 }),
      budget: num(v.budget, 'Budget', { min: 0 }),
      status: oneOf(v.status ?? 'new', 'Status', STATUSES, { required: true }),
      notes: str(v.notes, 'Notes', { max: 5000 }),
      assigned_to: id(v.assigned_to, 'Assigned to'),
    };
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw badRequest('That email address doesn’t look right');
    return f;
  };
  const COLS = ['title', 'name', 'email', 'phone', 'location_id', 'event_type', 'event_date', 'start_time', 'end_time', 'guests', 'budget', 'status', 'notes', 'assigned_to'];
  const checkSite = (req, f) => {
    if (f.location_id && !req.user.site_ids.includes(f.location_id)) throw notFound('Site');
    if (f.assigned_to && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(f.assigned_to)) throw notFound('Person');
  };

  router.post('/events/enquiries', perm, (req, res) => {
    const f = fields(req.body ?? {});
    checkSite(req, f);
    const r = db.prepare(`INSERT INTO event_enquiries (${COLS.join(', ')}, created_by, last_message_at) VALUES (${COLS.map(() => '?').join(', ')}, ?, datetime('now'))`)
      .run(...COLS.map((c) => f[c]), req.user.id);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // The enquiry, its conversation (oldest first) and its files. Opening it marks it read.
  router.get('/events/enquiries/:id', perm, (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    if (e.unread) db.prepare('UPDATE event_enquiries SET unread = 0 WHERE id = ?').run(e.id);
    res.json({
      ...e,
      unread: 0,
      location_name: e.location_id ? db.prepare('SELECT name FROM locations WHERE id = ?').get(e.location_id)?.name : null,
      messages: db.prepare(`SELECT m.id, m.direction, m.from_address, m.from_name, m.to_address, m.subject, m.body, m.status, m.error, m.created_at, u.name AS sent_by_name
        FROM enquiry_messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.enquiry_id = ? ORDER BY m.created_at, m.id`).all(e.id),
      files: db.prepare('SELECT id, message_id, file_name, file_type, size FROM enquiry_files WHERE enquiry_id = ? ORDER BY id').all(e.id),
      can_send: !!mailbox,
      can_read: !!reader,
      filled_fields: (() => { try { return JSON.parse(e.filled_fields ?? '[]'); } catch { return []; } })(),
      mailbox: mailbox?.address ?? null,
    });
  });

  // Read their emails again and fill in any details still missing.
  router.post('/events/enquiries/:id/fill', perm, async (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    if (!reader) throw badRequest('Reading emails needs ANTHROPIC_API_KEY (the same key as the invoice reader)');
    let filled;
    try { filled = await fillFromEmails(db, reader, e.id); } catch (err) { throw new HttpError(502, `Their emails couldn’t be read: ${err.message}`); }
    res.json({ filled });
  });

  router.put('/events/enquiries/:id', perm, (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    const f = fields(req.body ?? {}, e);
    checkSite(req, f);
    // Saving the details means someone has checked them, so the "filled in from their email" marks go.
    db.prepare(`UPDATE event_enquiries SET ${COLS.map((c) => `${c} = ?`).join(', ')}, filled_fields = NULL, updated_at = datetime('now') WHERE id = ?`).run(...COLS.map((c) => f[c]), e.id);
    res.json({ ok: true });
  });

  router.delete('/events/enquiries/:id', perm, (req, res) => {
    db.prepare('DELETE FROM event_enquiries WHERE id = ?').run(enquiry(req, Number(req.params.id)).id);
    res.json({ ok: true });
  });

  // { kind: 'email' | 'note' | 'logged', body, subject? }. An email is sent from the events inbox – as a reply in the
  // customer's thread when they've emailed, otherwise a new email. 'logged' records one sent from someone's own email.
  router.post('/events/enquiries/:id/messages', perm, async (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    const kind = oneOf(req.body?.kind, 'kind', ['email', 'note', 'logged'], { required: true });
    const body = str(req.body?.body, 'Message', { required: true, max: 20000 });
    const subject = str(req.body?.subject, 'Subject', { max: 300 }) ?? `Re: ${e.title || 'your event enquiry'}`;
    const add = (direction, extra = {}) => db.prepare(`INSERT INTO enquiry_messages (enquiry_id, direction, from_address, to_address, subject, body, sent_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(e.id, direction, extra.from ?? null, extra.to ?? null, direction === 'note' ? null : subject, body, req.user.id, extra.status ?? 'sent');
    if (kind === 'note') {
      add('note');
      return res.status(201).json({ ok: true });
    }
    if (!e.email) throw badRequest('Add their email address first');
    if (kind === 'email') {
      if (!mailbox) throw badRequest('The events inbox isn’t connected, so Atlas can’t send emails yet');
      const last = db.prepare(`SELECT email_message_id FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' AND email_message_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(e.id);
      try {
        if (last) await mailbox.reply(last.email_message_id, body);
        else await mailbox.send({ to: e.email, subject, text: body });
      } catch (err) {
        throw new HttpError(502, `The email wasn’t sent: ${err.message}`);
      }
    }
    tx(db, () => {
      add('out', { from: mailbox?.address ?? null, to: e.email, status: kind === 'logged' ? 'logged' : 'sent' });
      db.prepare(`UPDATE event_enquiries SET status = CASE WHEN status = 'new' THEN 'replied' ELSE status END, unread = 0,
        last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(e.id);
    });
    res.status(201).json({ ok: true });
  });

  router.get('/events/enquiries/:id/files/:fileId', perm, (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    const f = db.prepare('SELECT file_name, file_type, file FROM enquiry_files WHERE id = ? AND enquiry_id = ?').get(Number(req.params.fileId), e.id);
    if (!f) throw notFound('File');
    res.setHeader('Content-Type', f.file_type);
    res.setHeader('Content-Disposition', `${f.file_type === 'application/pdf' || f.file_type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${f.file_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.send(globalThis.Buffer ? Buffer.from(f.file) : f.file);
  });

  // The calendar: events with a date between from and to (not lost ones).
  router.get('/events/calendar', perm, (req, res) => {
    const from = date(req.query.from, 'from', { required: true });
    const to = date(req.query.to, 'to', { required: true });
    const site = id(req.query.location_id, 'location_id');
    const rows = db.prepare(`SELECT e.id, e.title, e.name, e.event_type, e.event_date, e.start_time, e.end_time, e.guests, e.status, e.location_id, l.name AS location_name
      FROM event_enquiries e LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.event_date BETWEEN ? AND ? AND e.status != 'lost' ${site ? 'AND e.location_id = ?' : ''}
      ORDER BY e.event_date, COALESCE(e.start_time, '99:99')`).all(from, to, ...(site ? [site] : []));
    res.json(rows.filter((e) => canSee(req, e)));
  });
}
