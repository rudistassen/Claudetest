// Emailed reports: the dashboard sent to chosen people at a set time on chosen days. Each person gets the
// sites they can access, and only the figures their permissions allow (sales and labour need "sales.view").
import { ACCESS_FIELDS, ACCESS_JOIN, can, PUBLIC_USER_FIELDS, requireAdmin, siteIdsFor, withPermissions } from './auth.js';
import { siteSummaries } from './dashboard.js';
import { dayOfWeek, nowMinutes } from './metrics.js';
import { addDays, badRequest, bool, notFound, oneOf, str, time, today } from './util.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LABOUR_TARGET = 30;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n === null || n === undefined ? '–' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pctText = (n) => (n === null || n === undefined ? '–' : `${n.toFixed(1)}%`);
const duration = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const appUrl = (env = process.env) => env.APP_URL?.replace(/\/$/, '')
  || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);

/** A person as the app sees them when signed in: their permissions and sites. */
function loadPerson(db, userId) {
  const u = withPermissions(db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.id = ? AND u.active = 1`).get(userId));
  if (u) u.site_ids = siteIdsFor(db, u);
  return u;
}

// "▲ 12.0%" against last week; green/red for sales, grey for labour.
function change(now, then, { goodUp = true } = {}) {
  if (now === null || now === undefined || !then) return { html: '<span style="color:#888">–</span>', text: '' };
  const c = ((now - then) / then) * 100;
  const colour = !goodUp || Math.abs(c) < 0.5 ? '#555' : (c > 0) === goodUp ? '#1f7a4d' : '#b3261e';
  const t = `${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}%`;
  return { html: `<span style="color:${colour};font-weight:600">${t}</span>`, text: `${t} vs ${money(then)}` };
}

/**
 * The email for one person: { subject, html, text }, or null when they have no sites. period 'today' covers
 * today so far; 'yesterday' the whole of yesterday.
 */
export function buildReport(db, person, { period = 'today', name = 'Daily report', url = appUrl() } = {}) {
  const locations = db.prepare('SELECT id, name, square_location_id FROM locations WHERE active = 1 ORDER BY name').all()
    .filter((l) => person.site_ids.includes(l.id));
  if (!locations.length) return null;
  const seeSales = can(person, 'sales.view');
  const fullDay = period === 'yesterday';
  const day = fullDay ? addDays(today(), -1) : today();
  const data = siteSummaries(db, {
    locations, seeSales, seeOrders: can(person, 'orders.manage'), seeClockIns: seeSales || can(person, 'staff.manage'), date: day, fullDay,
  });
  const sites = data.locations;
  const upTo = fullDay ? 'full day' : `up to ${hhmm(nowMinutes())}`;
  const compare = `${fullDay ? 'vs' : 'vs the same time on'} ${shortDate(data.compare_date)}`;
  const scope = sites.length === 1 ? sites[0].name : `${sites.length} sites`;

  const sum = (f) => sites.reduce((n, s) => n + (f(s) ?? 0), 0);
  const tot = seeSales ? {
    net: sum((s) => s.sales_today), gross: sum((s) => s.gross_today), labour: sum((s) => s.labour_cost_today),
    lwNet: sum((s) => s.last_week.net), lwGross: sum((s) => s.last_week.gross), lwLabour: sum((s) => s.last_week.labour_cost),
  } : null;
  const totPct = tot && tot.net ? (tot.labour / tot.net) * 100 : null;
  const pctColour = (p) => (p === null ? '#555' : p <= LABOUR_TARGET ? '#1f7a4d' : p <= LABOUR_TARGET * 1.2 ? '#a15c00' : '#b3261e');

  const th = 'padding:6px 5px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #ddd;font-weight:600';
  const td = 'padding:6px 5px;border-bottom:1px solid #eee;font-size:14px';
  const num = `${td};text-align:right;white-space:nowrap`;
  const stat = (label, value, sub) => `<td width="33%" style="padding:8px 10px;background:#f4f1ea;border-radius:8px;vertical-align:top">
    <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em">${label}</div>
    <div style="font-size:18px;font-weight:700;margin-top:2px">${value}</div><div style="font-size:12px;margin-top:2px">${sub}</div></td>`;

  const summary = tot ? `
    <table role="presentation" width="100%" cellspacing="6" cellpadding="0" style="margin:8px -6px 4px"><tr>
      ${stat('Gross sales', money(tot.gross), change(tot.gross, tot.lwGross).html)}
      ${stat('Net sales', money(tot.net), change(tot.net, tot.lwNet).html)}
      ${stat('Labour cost', money(tot.labour), `<span style="color:${pctColour(totPct)};font-weight:600">${pctText(totPct)} of sales</span>`)}
    </tr></table>
    <p style="margin:0 0 16px;font-size:12px;color:#777">Changes are ${compare}${fullDay ? '' : ' up to the same time'}.</p>` : '';

  const table = sites.length < 2 ? '' : `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:20px">
      <tr><th style="${th}">Site</th>${seeSales ? `<th style="${th};text-align:right">Net sales</th><th style="${th};text-align:right">vs last wk</th><th style="${th};text-align:right">Labour %</th>` : ''}<th style="${th};text-align:right">Checks</th></tr>
      ${sites.map((s) => `<tr><td style="${td};font-weight:600">${esc(s.name)}</td>
        ${seeSales ? `<td style="${num}">${money(s.sales_today)}</td><td style="${num}">${change(s.sales_today, s.last_week.net).html}</td>
        <td style="${num};color:${pctColour(s.labour_pct_today)};font-weight:600">${pctText(s.labour_pct_today)}</td>` : ''}
        <td style="${num}">${s.daily.done} / ${s.daily.due}${s.daily.fails ? ` <span style="color:#b3261e">⚠ ${s.daily.fails}</span>` : ''}</td></tr>`).join('')}
    </table>`;

  const siteBlock = (s) => {
    const people = s.clock_ins ?? null;
    return `
    <div style="border:1px solid #e3ded3;border-radius:10px;padding:14px 16px;margin-bottom:14px">
      <h2 style="margin:0 0 8px;font-size:17px">${esc(s.name)}</h2>
      ${seeSales ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.6">
        Gross <strong>${money(s.gross_today)}</strong> ${change(s.gross_today, s.last_week.gross).html} &nbsp;·&nbsp;
        Net <strong>${money(s.sales_today)}</strong> ${change(s.sales_today, s.last_week.net).html} &nbsp;·&nbsp;
        Labour <strong>${money(s.labour_cost_today)}</strong> ${change(s.labour_cost_today, s.last_week.labour_cost, { goodUp: false }).html}
        ${s.labour_pct_today === null ? '' : `<span style="color:${pctColour(s.labour_pct_today)}">(${pctText(s.labour_pct_today)} of sales)</span>`}</p>` : ''}
      ${people && data.labour_synced ? `
      <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-top:6px">Clocked in (${people.length})</div>
      ${people.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:4px 0 6px">
        ${people.map((c) => `<tr><td style="padding:3px 0;font-size:14px;border-bottom:1px dashed #e5e5e5"><strong>${esc(c.name)}</strong> <span style="color:#777">${c.start}–${c.end ?? 'still in'}</span></td>
          <td style="padding:3px 0;font-size:14px;text-align:right;white-space:nowrap;border-bottom:1px dashed #e5e5e5">${duration(c.hours)}</td></tr>`).join('')}
        <tr><td style="padding:4px 0;font-size:12px;color:#777">Total</td><td style="padding:4px 0;font-size:12px;color:#777;text-align:right">${duration(people.reduce((n, c) => n + c.hours, 0))}</td></tr>
      </table>` : '<p style="margin:4px 0 8px;font-size:14px;color:#777">Nobody clocked in</p>'}` : `
      <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-top:6px">On the rota (${s.shifts_today.length})</div>
      <p style="margin:4px 0 8px;font-size:14px">${s.shifts_today.length ? s.shifts_today.map((x) => `${esc(x.name)} ${x.start_time}–${x.end_time}`).join(' · ') : '<span style="color:#777">Nobody rostered</span>'}</p>`}
      <p style="margin:8px 0 0;font-size:14px;color:#333">Wastage (7 days) <strong>${money(s.wastage_7d)}</strong>
        &nbsp;·&nbsp; Daily Trail checks <strong>${s.daily.done} / ${s.daily.due}</strong>${s.daily.fails ? ` <span style="color:#b3261e">⚠ ${s.daily.fails} failed</span>` : ''}
        &nbsp;·&nbsp; Weekly <strong>${s.weekly.done} / ${s.weekly.due}</strong>${s.weekly.fails ? ` <span style="color:#b3261e">⚠ ${s.weekly.fails} failed</span>` : ''}</p>
    </div>`;
  };

  const heading = `${fullDay ? 'Yesterday' : 'Today'} · ${longDate(day)}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1d">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:12px 4px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border-radius:12px"><tr><td style="padding:0">
    <div style="background:#1f5c4a;color:#fff;padding:14px 16px;border-radius:12px 12px 0 0">
      <div style="font-size:13px;opacity:.85">Brewly · ${esc(name)}</div>
      <div style="font-size:21px;font-weight:700;margin-top:2px">${heading}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">${esc(scope)} · ${upTo}</div>
    </div>
    <div style="padding:14px 14px 4px">
      ${summary}
      ${table}
      ${sites.map(siteBlock).join('')}
      ${url ? `<p style="margin:18px 0 6px"><a href="${esc(url)}" style="display:inline-block;background:#1f5c4a;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">Open Brewly</a></p>` : ''}
      <p style="margin:14px 0 18px;font-size:12px;color:#888">Figures are as of the last Square sync. You get this email because an admin added you to “${esc(name)}” in Brewly (Setup → Email reports).</p>
    </div>
  </td></tr></table></td></tr></table></body></html>`;

  const text = [
    `Brewly · ${name}`, heading, `${scope} · ${upTo}`, '',
    ...(tot ? [`Gross sales ${money(tot.gross)} ${change(tot.gross, tot.lwGross).text}`, `Net sales ${money(tot.net)} ${change(tot.net, tot.lwNet).text}`,
      `Labour ${money(tot.labour)} (${pctText(totPct)} of sales)`, `Changes are ${compare}.`, ''] : []),
    ...sites.flatMap((s) => [
      `== ${s.name} ==`,
      ...(seeSales ? [`Gross ${money(s.gross_today)} ${change(s.gross_today, s.last_week.gross).text}`, `Net ${money(s.sales_today)} ${change(s.sales_today, s.last_week.net).text}`,
        `Labour ${money(s.labour_cost_today)} (${pctText(s.labour_pct_today)} of sales)`] : []),
      ...(s.clock_ins && data.labour_synced ? [`Clocked in: ${s.clock_ins.map((c) => `${c.name} ${c.start}-${c.end ?? 'still in'} (${duration(c.hours)})`).join('; ') || 'nobody'}`] : []),
      `Daily Trail checks ${s.daily.done}/${s.daily.due}, weekly ${s.weekly.done}/${s.weekly.due}. Wastage (7 days) ${money(s.wastage_7d)}`, '',
    ]),
    ...(url ? [url] : []),
  ].join('\n');

  const subject = `${name} · ${shortDate(day)}${fullDay ? '' : ` ${upTo.replace('up to ', 'at ')}`}${tot ? ` · ${money(tot.net)} net sales` : ''}`;
  return { subject, html, text };
}

// --- Schedules ---

function withRecipients(db, schedule) {
  const people = db.prepare(`SELECT u.id, u.name, u.email FROM report_recipients r JOIN users u ON u.id = r.user_id
    WHERE r.schedule_id = ? ORDER BY u.name`).all(schedule.id);
  return { ...schedule, days: [...schedule.days].map(Number), recipients: people };
}

/** Sends one schedule's report to each of its people. Returns { sent, failed: [{ name, error }] }. */
export async function sendSchedule(db, mailer, schedule, { onlyTo = null } = {}) {
  const ids = onlyTo ? [onlyTo] : db.prepare('SELECT user_id FROM report_recipients WHERE schedule_id = ?').all(schedule.id).map((r) => r.user_id);
  let sent = 0;
  const failed = [];
  for (const id of ids) {
    const person = loadPerson(db, id);
    if (!person?.email) continue;
    try {
      const report = buildReport(db, person, { period: schedule.period, name: schedule.name });
      if (!report) continue;
      await mailer.send({ to: person.email, name: person.name, ...report });
      sent++;
    } catch (err) {
      failed.push({ name: person.name, error: err.message });
    }
  }
  return { sent, failed };
}

/**
 * Sends every schedule that is due: switched on, today is one of its days, its time has passed and it hasn't
 * gone today. beforeSend runs first (e.g. a Square sync so the figures are fresh).
 */
export async function runDueReports(db, mailer, { beforeSend, log = console, now = { date: today(), minutes: nowMinutes() } } = {}) {
  const dow = String(dayOfWeek(now.date));
  const due = db.prepare(`SELECT * FROM report_schedules WHERE active = 1 AND send_time <= ? AND (last_sent_date IS NULL OR last_sent_date < ?)`)
    .all(hhmm(now.minutes), now.date).filter((s) => s.days.includes(dow));
  if (!due.length) return [];
  // Marked as sent first, so a crash part-way can't send the same email twice.
  const mark = db.prepare('UPDATE report_schedules SET last_sent_date = ? WHERE id = ?');
  for (const s of due) mark.run(now.date, s.id);
  if (beforeSend) {
    try { await beforeSend(due); } catch (err) { log.error(`Before sending reports: ${err.message}`); }
  }
  const results = [];
  for (const s of due) {
    const r = await sendSchedule(db, mailer, s);
    const summary = `${now.date} ${hhmm(now.minutes)}: sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}${r.failed.length ? `; failed for ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}` : ''}`;
    db.prepare('UPDATE report_schedules SET last_result = ? WHERE id = ?').run(summary, s.id);
    log.log(`Email report “${s.name}” ${summary}`);
    results.push({ id: s.id, ...r });
  }
  return results;
}

/** Checks every minute for reports that are due. */
export function startReportScheduler(db, mailer, { beforeSend, log = console } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runDueReports(db, mailer, { beforeSend, log }); } catch (err) { log.error(`Email reports: ${err.message}`); } finally { busy = false; }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 60 * 1000);
}

export function registerReportRoutes(router, db, mailer, { demo = false } = {}) {
  const load = (id) => {
    const s = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(Number(id));
    if (!s) throw notFound('Email report');
    return s;
  };
  const body = (b) => {
    const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw badRequest('Pick at least one day');
    const ids = [...new Set((Array.isArray(b.recipient_ids) ? b.recipient_ids : []).map(Number))];
    const known = new Set(db.prepare(`SELECT id FROM users WHERE active = 1 AND email IS NOT NULL AND email != ''`).all().map((u) => u.id));
    if (ids.some((i) => !known.has(i))) throw badRequest('Someone picked is no longer active or has no email address');
    if (!ids.length) throw badRequest('Pick at least one person to send it to');
    return {
      name: str(b.name, 'name', { required: true, max: 100 }),
      send_time: time(b.send_time, 'send_time', { required: true }),
      days: days.join(''),
      period: oneOf(b.period, 'period', ['today', 'yesterday']) ?? 'today',
      active: b.active === undefined ? 1 : bool(b.active),
      ids,
    };
  };
  // A new or changed time that has already passed today starts tomorrow, rather than sending straight away.
  const firstDate = (sendTime) => (sendTime <= hhmm(nowMinutes()) ? today() : null);
  const save = (id, v) => {
    db.prepare('DELETE FROM report_recipients WHERE schedule_id = ?').run(id);
    const ins = db.prepare('INSERT INTO report_recipients (schedule_id, user_id) VALUES (?, ?)');
    for (const u of v.ids) ins.run(id, u);
    return withRecipients(db, load(id));
  };
  const needMailer = () => {
    if (!mailer) throw badRequest('Email isn’t set up yet. Add BREVO_API_KEY and EMAIL_FROM to the app’s settings (see Setup → Email reports).');
  };

  router.get('/reports/email', requireAdmin, (req, res) => {
    const people = db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS}, l.name AS location_name FROM users u ${ACCESS_JOIN}
      LEFT JOIN locations l ON l.id = u.location_id WHERE u.active = 1 AND u.email IS NOT NULL AND u.email != '' ORDER BY u.name`).all()
      .map(withPermissions)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, access_name: u.access_name, location_name: u.location_name, sees_sales: can(u, 'sales.view'), sites: siteIdsFor(db, u).length }));
    res.json({
      ready: !!mailer,
      demo,
      sender: mailer?.from ?? null,
      app_url: appUrl(),
      weekdays: WEEKDAYS,
      now: hhmm(nowMinutes()),
      today: today(),
      schedules: db.prepare('SELECT * FROM report_schedules ORDER BY send_time, name').all().map((s) => withRecipients(db, s)),
      people,
    });
  });

  router.post('/reports/email', requireAdmin, (req, res) => {
    const v = body(req.body);
    const r = db.prepare('INSERT INTO report_schedules (name, send_time, days, period, active, last_sent_date) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.name, v.send_time, v.days, v.period, v.active, firstDate(v.send_time));
    res.status(201).json(save(r.lastInsertRowid, v));
  });

  router.put('/reports/email/:id', requireAdmin, (req, res) => {
    const s = load(req.params.id);
    const v = body(req.body);
    // Already sent today: not again today. Otherwise a time that has passed today starts tomorrow.
    const last = s.last_sent_date === today() ? s.last_sent_date : firstDate(v.send_time) ?? s.last_sent_date;
    db.prepare('UPDATE report_schedules SET name = ?, send_time = ?, days = ?, period = ?, active = ?, last_sent_date = ? WHERE id = ?')
      .run(v.name, v.send_time, v.days, v.period, v.active, last, s.id);
    res.json(save(s.id, v));
  });

  router.delete('/reports/email/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM report_schedules WHERE id = ?').run(load(req.params.id).id);
    res.json({ ok: true });
  });

  // What the email looks like for one of its people (or for you).
  router.get('/reports/email/:id/preview', requireAdmin, (req, res) => {
    const s = load(req.params.id);
    const person = loadPerson(db, Number(req.query.user_id) || req.user.id);
    if (!person) throw notFound('Person');
    const report = buildReport(db, person, { period: s.period, name: s.name });
    if (!report) throw badRequest(`${person.name} doesn’t have access to any sites`);
    res.json({ to: person.name, email: person.email, ...report });
  });

  // Send now: to you only (a test), or to everyone on the list.
  router.post('/reports/email/:id/send', requireAdmin, async (req, res) => {
    needMailer();
    const s = load(req.params.id);
    const toMe = req.body.to !== 'all';
    if (toMe && !req.user.email) throw badRequest('Your account has no email address');
    const r = await sendSchedule(db, mailer, s, { onlyTo: toMe ? req.user.id : null });
    if (!toMe) db.prepare('UPDATE report_schedules SET last_result = ? WHERE id = ?')
      .run(`${today()} ${hhmm(nowMinutes())}: sent now by ${req.user.name} to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}${r.failed.length ? `; failed for ${r.failed.map((f) => f.name).join(', ')}` : ''}`, s.id);
    if (!r.sent && r.failed.length) throw badRequest(r.failed[0].error);
    res.json(r);
  });
}
