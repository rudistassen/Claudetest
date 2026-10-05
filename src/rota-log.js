// The rota's change log: who added, changed, removed or published which shifts, and when. Each entry keeps the
// names as they were at the time, so it still reads correctly after someone leaves or a site is renamed.
import { shiftHours } from './util.js';

const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const fmtDay = (iso) => dayFormat.format(new Date(`${iso}T00:00:00Z`));
const nameOf = (db, table, id) => (id ? db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id)?.name ?? null : null);

/** "Tue 29 Sept · 07:00–15:00 (30m break)" */
export function shiftText(s) {
  return `${fmtDay(s.date)} · ${s.start_time}–${s.end_time}${s.break_minutes ? ` (${s.break_minutes}m break)` : ''}`;
}

/** What changed between two versions of a shift, in words. */
export function shiftChanges(db, before, after) {
  const out = [];
  if (before.user_id !== after.user_id) out.push(`person ${nameOf(db, 'users', before.user_id) ?? '?'} → ${nameOf(db, 'users', after.user_id) ?? '?'}`);
  if (before.location_id !== after.location_id) out.push(`site ${nameOf(db, 'locations', before.location_id) ?? '?'} → ${nameOf(db, 'locations', after.location_id) ?? '?'}`);
  if (before.date !== after.date) out.push(`day ${fmtDay(before.date)} → ${fmtDay(after.date)}`);
  if (before.start_time !== after.start_time || before.end_time !== after.end_time) {
    out.push(`time ${before.start_time}–${before.end_time} → ${after.start_time}–${after.end_time}`);
  }
  if ((before.break_minutes ?? 0) !== (after.break_minutes ?? 0)) out.push(`break ${before.break_minutes ?? 0}m → ${after.break_minutes ?? 0}m`);
  if ((before.position ?? '') !== (after.position ?? '')) out.push(`position “${before.position ?? ''}” → “${after.position ?? ''}”`);
  if ((before.notes ?? '') !== (after.notes ?? '')) out.push('notes changed');
  return out;
}

/**
 * Records one change. entry: { action, location_id, shift (the shift it's about, for its person and day), details }.
 * Actions: add, change, remove, restore, publish_shift, publish, discard, copy, drop, claim, withdraw, sick.
 */
export function logRota(db, req, { action, location_id, shift = null, details = '' }) {
  db.prepare(`INSERT INTO rota_log (actor_id, actor_name, action, location_id, location_name, shift_id, staff_id, staff_name, shift_date, hours, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, req.user.name, action, location_id, nameOf(db, 'locations', location_id),
    shift?.id ?? null, shift?.user_id ?? null, shift ? nameOf(db, 'users', shift.user_id) : null, shift?.date ?? null,
    shift ? Math.round(shiftHours(shift.start_time, shift.end_time, shift.break_minutes ?? 0) * 100) / 100 : null, details,
  );
}
