// Emailing people their shifts when the rota is published (switched on in Setup → Email → Rota changes): everyone
// whose shifts changed gets their published shifts for that week, at every site, with the total hours.
import { emailOn } from './email.js';
import { appUrl } from './reports.js';
import { addDays, round2, shiftHours } from './util.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
// Pretend addresses (the demo's people, examples) aren't emailed outside the demo.
const realAddress = (e, demo) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e ?? '') && (demo || !/@(cafe\.local|example\.(com|org|net))$/i.test(e));

/** The email for one person's week: { subject, text, html }. */
export function rotaEmail(db, user, ws) {
  const we = addDays(ws, 6);
  const shifts = db.prepare(`SELECT s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes, s.sick, l.name AS location_name
    FROM published_shifts s JOIN locations l ON l.id = s.location_id WHERE s.user_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`).all(user.id, ws, we);
  const hours = round2(shifts.filter((s) => !s.sick).reduce((t, s) => t + shiftHours(s.start_time, s.end_time, s.break_minutes), 0));
  const first = String(user.name ?? '').split(' ')[0] || 'there';
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).map((d) => ({ d, list: shifts.filter((s) => s.date === d) }));
  const link = appUrl() ? `${appUrl()}/#/rota?view=mine&week=${ws}` : null;
  const line = (s) => `${s.start_time}–${s.end_time} at ${s.location_name}${s.break_minutes ? ` (${s.break_minutes} min break)` : ''}${s.position ? ` · ${s.position}` : ''}${s.sick ? ' · off sick' : ''}`;
  const subject = `Your shifts for the week of ${shortDay(ws)}`;
  const text = [`Hi ${first},`, `The rota for the week of ${shortDay(ws)} has been published and your shifts have changed. Here’s your week:`,
    days.map(({ d, list }) => `${dayName(d)}: ${list.length ? list.map(line).join('; ') : 'Day off'}`).join('\n'),
    `Total: ${hours} hours`, link ? `See your shifts in Atlas: ${link}` : 'See your shifts in Atlas.',
    'If something doesn’t look right, speak to your manager.'].join('\n\n');
  const rows = days.map(({ d, list }) => `<tr><td style="padding:7px 10px;border-bottom:1px solid #e6dccd;white-space:nowrap;vertical-align:top"><strong>${esc(dayName(d))}</strong></td>
    <td style="padding:7px 10px;border-bottom:1px solid #e6dccd">${list.length ? list.map((s) => esc(line(s))).join('<br>') : '<span style="color:#8a7a68">Day off</span>'}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2b2118;line-height:1.5">
    <p>Hi ${esc(first)},</p>
    <p>The rota for the week of <strong>${esc(shortDay(ws))}</strong> has been published and your shifts have changed. Here’s your week:</p>
    <table style="border-collapse:collapse;margin:6px 0 12px">${rows}
      <tr><td style="padding:7px 10px"><strong>Total</strong></td><td style="padding:7px 10px"><strong>${hours} hours</strong></td></tr></table>
    ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:bold">See your shifts in Atlas</a></p>` : ''}
    <p style="color:#6e5d4b">If something doesn’t look right, speak to your manager.</p></div>`;
  return { subject, text, html };
}

/**
 * Emails each person their week (in the background – publishing doesn't wait). Does nothing unless Rota changes
 * emails are switched on. Returns a promise of { sent, skipped, failed }.
 */
export async function emailRotaChanges(db, mailer, userIds, ws, { demo = false, log = console } = {}) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!mailer || !emailOn(db, 'rota') || !userIds.length) return result;
  const people = db.prepare(`SELECT id, name, email FROM users WHERE active = 1 AND id IN (${userIds.map(() => '?').join(', ')})`).all(...userIds);
  for (const u of people) {
    if (!realAddress(u.email, demo)) { result.skipped++; continue; }
    try {
      await mailer.send({ kind: 'rota', to: u.email, name: u.name, ...rotaEmail(db, u, ws) });
      result.sent++;
    } catch (err) {
      result.failed++;
      log.error(`Rota email to ${u.name}: ${err.message}`);
      if (err.senderProblem || err.switchedOff) break;
    }
  }
  return result;
}
