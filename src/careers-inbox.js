// The careers inbox: every few minutes, new emails to the shared careers address become candidates on People →
// Recruitment, with their message and their CV (or anything else they attached) on their profile. Someone who
// emails again is added to the profile they already have. Each email is only handled once.
import { requirePerm } from './auth.js';
import { tx } from './db.js';
import { getSetting, setSetting } from './invoice-inbox.js';
import { CAREERS_VARIABLES, mailboxSetup } from './mailbox.js';
import { fromBase64 } from './routes/invoices.js';
import { badRequest, str } from './util.js';
import { notify, peopleWith } from './push.js';

const KEY = { since: 'careers_inbox_since', lastCheck: 'careers_inbox_last_check', lastError: 'careers_inbox_last_error',
  declineSubject: 'careers_decline_subject', declineBody: 'careers_decline_body' };
const MAX_ATTEMPTS = 3;
// The first time the inbox is checked, emails from the last fortnight are brought in.
const FIRST_DAYS = 14;
export const MAX_CV_BYTES = 10 * 1024 * 1024;
// Small pictures in emails are usually logos in someone's signature, not CVs.
const MIN_IMAGE_BYTES = 15 * 1024;

export const CV_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  pages: 'application/vnd.apple.pages',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
};

/** The type of a CV-like file from its name (types sent by email programs vary too much to trust), or null. */
export function cvType(name, given = '') {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  return CV_TYPES[ext] ?? (Object.values(CV_TYPES).includes(String(given).toLowerCase()) ? String(given).toLowerCase() : null);
}

/** The attachments worth keeping: documents and photos, not signature logos or other inline pictures. */
export function cvAttachments(list) {
  return list
    .map((a) => ({ ...a, type: cvType(a.name, a.contentType), bytes: a.size || Math.floor((a.data?.length ?? 0) * 0.75) }))
    .filter((a) => a.type && !a.isInline && a.bytes <= MAX_CV_BYTES && (!a.type.startsWith('image/') || a.bytes >= MIN_IMAGE_BYTES));
}

// Emails that aren't from a person applying: out-of-office replies, bounces and automatic senders.
const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|out of (the )?office|undeliverable|delivery (status|has failed)|mail delivery|returned mail|read:)/i;
const AUTO_SENDER = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@)/i;

const norm = (t) => String(t ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A UK phone number in the email, if there's one. */
export function findPhone(text) {
  const m = String(text ?? '').match(/(?:\+44\s?\(?0?\)?\s?|\b0)7\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

/** The open job an email is about (its title in the subject or the start of the message), or null. */
function pickJob(db, m, body) {
  const text = ` ${norm(`${m.subject} ${String(body).slice(0, 600)}`)} `;
  const jobs = db.prepare(`SELECT v.id, v.title, v.location_id, l.name AS site FROM vacancies v JOIN locations l ON l.id = v.location_id WHERE v.status = 'open'`).all()
    .filter((j) => norm(j.title) && text.includes(` ${norm(j.title)} `));
  if (!jobs.length) return null;
  // Two open jobs with the same title at different sites: the one whose site is named.
  return jobs.find((j) => text.includes(` ${norm(j.site)} `)) ?? (jobs.length === 1 ? jobs[0] : null);
}

function pickSite(db, m, body) {
  const text = ` ${norm(`${m.subject} ${String(body).slice(0, 600)}`)} `;
  return db.prepare('SELECT id, name FROM locations WHERE active = 1').all()
    .filter((s) => norm(s.name) && text.includes(` ${norm(s.name)} `))
    .sort((a, b) => norm(b.name).length - norm(a.name).length)[0]?.id ?? null;
}

const cleanBody = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);

async function handle(db, mailbox, m) {
  const from = String(m.from ?? '').trim();
  if (!from) return { status: 'skipped', detail: 'No sender' };
  if (from.toLowerCase() === String(mailbox.address).toLowerCase()) return { status: 'skipped', detail: 'Sent from the careers inbox itself' };
  if (AUTO_SUBJECT.test(m.subject ?? '') || AUTO_SENDER.test(from)) return { status: 'skipped', detail: 'An automatic email, not an application' };
  const body = cleanBody(await mailbox.body(m.id));
  const files = cvAttachments(m.hasAttachments === false ? [] : await mailbox.attachments(m.id));
  const name = (m.fromName && !m.fromName.includes('@') ? m.fromName : from.split('@')[0].replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).slice(0, 100);
  const addFile = db.prepare('INSERT INTO candidate_files (candidate_id, file_name, file_type, size, file) VALUES (?, ?, ?, ?, ?)');
  // Saved all together, so a problem part-way leaves nothing half-added (the email is tried again next time).
  const out = tx(db, () => {
    // Someone who has emailed before and is still being considered: added to their profile.
    const already = db.prepare(`SELECT id, message FROM candidates WHERE lower(email) = lower(?) AND stage NOT IN ('hired', 'rejected')
      ORDER BY id DESC LIMIT 1`).get(from);
    let candidateId;
    if (already) {
      const when = new Date(m.receivedAt ?? Date.now()).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const message = [already.message, `— Emailed again on ${when}${m.subject ? `: ${m.subject}` : ''} —\n\n${body}`].filter(Boolean).join('\n\n').slice(-40000);
      db.prepare(`UPDATE candidates SET message = ?, email_message_id = ?, phone = COALESCE(phone, ?), updated_at = datetime('now') WHERE id = ?`)
        .run(message, m.id, findPhone(body), already.id);
      candidateId = already.id;
    } else {
      const job = pickJob(db, m, body);
      candidateId = Number(db.prepare(`INSERT INTO candidates (vacancy_id, location_id, name, email, phone, source, subject, message, email_message_id, received_at)
        VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?)`).run(job?.id ?? null, job?.location_id ?? pickSite(db, m, body), name, from.slice(0, 200), findPhone(body),
        (m.subject ?? '').slice(0, 300) || null, body || null, m.id, m.receivedAt ?? null).lastInsertRowid);
    }
    for (const f of files) addFile.run(candidateId, String(f.name).slice(0, 200), f.type, f.bytes, fromBase64(f.data));
    return { status: 'added', candidateId, isNew: !already, detail: already ? 'Added to their existing profile' : null };
  });
  // A new application: whoever looks after recruitment at its site gets a notification.
  if (out.isNew) {
    const c = db.prepare('SELECT c.name, c.location_id, v.title FROM candidates c LEFT JOIN vacancies v ON v.id = c.vacancy_id WHERE c.id = ?').get(out.candidateId);
    notify(db, peopleWith(db, ['people.recruitment'], c?.location_id ?? null), 'application',
      { title: 'New job application', body: `${c?.name ?? name}${c?.title ? ` – ${c.title}` : ''}`, url: `/#/people/recruitment/candidates/${out.candidateId}`, tag: `application-${out.candidateId}` });
  }
  return out;
}

let running = null;
/** Checks the inbox once (the first time, bringing in the last fortnight's emails). */
export function checkCareers(db, { mailbox, now = new Date() }) {
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
      const seen = db.prepare('SELECT status, attempts FROM careers_emails WHERE message_id = ?');
      const save = db.prepare(`INSERT INTO careers_emails (message_id, received_at, from_address, subject, status, candidate_id, detail, attempts, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, candidate_id = excluded.candidate_id, detail = excluded.detail,
          attempts = excluded.attempts, processed_at = excluded.processed_at`);
      for (const m of messages) {
        const before = seen.get(m.id);
        if (before && (before.status !== 'failed' || before.attempts >= MAX_ATTEMPTS)) continue;
        summary.checked++;
        let result;
        try {
          result = await handle(db, mailbox, m);
        } catch (err) {
          result = { status: 'failed', detail: err.message };
        }
        save.run(m.id, m.receivedAt ?? null, m.from ?? null, m.subject ?? null, result.status, result.candidateId ?? null, result.detail ?? null, (before?.attempts ?? 0) + 1);
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

export function startCareersInbox(db, { mailbox, minutes = 10, log = console }) {
  const run = async () => {
    const r = await checkCareers(db, { mailbox });
    if (r.error) log.error(`Careers inbox: ${r.error}`);
    else if (r.added) log.log(`Careers inbox: ${r.added} application(s) added`);
  };
  setTimeout(run, 30000);
  return setInterval(run, minutes * 60000);
}

// ---- The email sent to someone who isn't taken further ----

export const DEFAULT_DECLINE = {
  subject: 'Your application{job_for}',
  body: `Hi {first_name},

Thank you for your interest in joining us{job_as}, and for taking the time to get in touch.

We’ve had a lot of interest and, after careful consideration, we won’t be taking your application further on this occasion.

We really appreciate you thinking of us, and wish you the very best of luck in your search.

Best wishes,
The team`,
};

export const declineTemplate = (db) => ({
  subject: getSetting(db, KEY.declineSubject) ?? DEFAULT_DECLINE.subject,
  body: getSetting(db, KEY.declineBody) ?? DEFAULT_DECLINE.body,
});

/** The template filled in for one candidate: {first_name}, {name}, {job}, and {job_as} / {job_for} (" as a Barista"). */
export function fillTemplate(text, { name, job }) {
  const first = String(name ?? '').trim().split(/\s+/)[0] || 'there';
  const a = job && /^[aeiou]/i.test(job) ? 'an' : 'a';
  return String(text)
    .replaceAll('{first_name}', first)
    .replaceAll('{name}', String(name ?? '').trim() || 'there')
    .replaceAll('{job}', job ?? 'the role')
    .replaceAll('{job_as}', job ? ` as ${a} ${job}` : '')
    .replaceAll('{job_for}', job ? ` for ${job}` : '');
}

export function registerCareersRoutes(router, db, { mailbox }) {
  const perm = requirePerm('people.recruitment');
  const status = () => ({
    configured: !!mailbox,
    ...(mailbox ? {} : { setup: mailboxSetup(globalThis.process?.env ?? {}, CAREERS_VARIABLES) }),
    mailbox: mailbox?.address ?? null,
    last_check: getSetting(db, KEY.lastCheck),
    last_error: getSetting(db, KEY.lastError),
    template: declineTemplate(db),
    default_template: DEFAULT_DECLINE,
  });
  router.get('/careers-inbox', perm, (_req, res) => res.json(status()));
  router.post('/careers-inbox/check', perm, async (_req, res) => {
    if (!mailbox) throw badRequest('The careers inbox isn’t connected yet');
    res.json({ ...(await checkCareers(db, { mailbox })), ...status() });
  });
  // The decline email's wording, shared by everyone.
  router.put('/careers-inbox/template', perm, (req, res) => {
    const subject = str(req.body?.subject, 'Subject', { required: true, max: 200 });
    const body = str(req.body?.body, 'Message', { required: true, max: 5000 });
    const same = subject === DEFAULT_DECLINE.subject && body === DEFAULT_DECLINE.body;
    setSetting(db, KEY.declineSubject, same ? null : subject);
    setSetting(db, KEY.declineBody, same ? null : body);
    res.json(status());
  });
}
