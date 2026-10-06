// Events: enquiries from the shared events inbox (or added by hand), the conversation about each one – emails in
// and out, sent from the events inbox so replies stay in the customer's thread – and the events calendar.
import { requirePerm } from './auth.js';
import { cvAttachments } from './careers-inbox.js';
import { tx } from './db.js';
import { getSetting, setSetting } from './invoice-inbox.js';
import { EVENTS_VARIABLES, mailboxSetup } from './mailbox.js';
import { fromBase64 } from './routes/invoices.js';
import { badRequest, date, HttpError, id, notFound, num, oneOf, str, time } from './util.js';

const KEY = { since: 'events_inbox_since', lastCheck: 'events_inbox_last_check', lastError: 'events_inbox_last_error' };
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
  const body = cleanBody(await mailbox.body(m.id));
  const files = cvAttachments(m.hasAttachments === false ? [] : await mailbox.attachments(m.id));
  return tx(db, () => {
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
      db.prepare(`UPDATE event_enquiries SET unread = 1, last_message_at = ?, conversation_id = COALESCE(conversation_id, ?), updated_at = datetime('now') WHERE id = ?`)
        .run(sqlTime(m.receivedAt) ?? sqlTime(new Date().toISOString()), m.conversationId ?? null, enquiryId);
    }
    const msgId = Number(db.prepare(`INSERT INTO enquiry_messages (enquiry_id, direction, from_address, from_name, to_address, subject, body, email_message_id, created_at)
      VALUES (?, 'in', ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(enquiryId, from.slice(0, 200), m.fromName ?? null, mailbox.address,
      (m.subject ?? '').slice(0, 300), body || null, m.id, sqlTime(m.receivedAt)).lastInsertRowid);
    const addFile = db.prepare('INSERT INTO enquiry_files (enquiry_id, message_id, file_name, file_type, size, file) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of files) addFile.run(enquiryId, msgId, String(f.name).slice(0, 200), f.type, f.bytes, fromBase64(f.data));
    return { status: 'added', enquiryId, detail: enquiry ? 'Added to an existing enquiry' : null };
  });
}

let running = null;
/** Checks the inbox once (the first time, bringing in the last fortnight's emails). */
export function checkEvents(db, { mailbox, now = new Date() }) {
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
        save.run(m.id, m.receivedAt ?? null, m.from ?? null, m.subject ?? null, result.status, result.enquiryId ?? null, result.detail ?? null, (before?.attempts ?? 0) + 1);
        summary[result.status]++;
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

export function startEventsInbox(db, { mailbox, minutes = 5, log = console }) {
  const run = async () => {
    const r = await checkEvents(db, { mailbox });
    if (r.error) log.error(`Events inbox: ${r.error}`);
    else if (r.added) log.log(`Events inbox: ${r.added} email(s) added`);
  };
  setTimeout(run, 40000);
  return setInterval(run, minutes * 60000);
}

export function registerEventRoutes(router, db, { mailbox = null } = {}) {
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
  });

  router.get('/events/inbox', perm, (_req, res) => res.json(status()));
  router.post('/events/inbox/check', perm, async (_req, res) => {
    if (!mailbox) throw badRequest('The events inbox isn’t connected yet');
    res.json({ ...(await checkEvents(db, { mailbox })), ...status() });
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
      mailbox: mailbox?.address ?? null,
    });
  });

  router.put('/events/enquiries/:id', perm, (req, res) => {
    const e = enquiry(req, Number(req.params.id));
    const f = fields(req.body ?? {}, e);
    checkSite(req, f);
    db.prepare(`UPDATE event_enquiries SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...COLS.map((c) => f[c]), e.id);
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
      if (!mailbox) throw badRequest('The events inbox isn’t connected, so Brewly can’t send emails yet');
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
