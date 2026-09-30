// Clock-ins compared with the published rota: who was late, who stayed on after their shift, who hasn't clocked
// in for a shift that's started, and who clocked in without being on the rota.
import { zonedMidnightUTC } from './util.js';

/** Minutes after the shift ends before clocking out counts as late. */
export const CLOCK_OUT_GRACE = 5;

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** A published shift's start and end as timestamps (an overnight shift ends the next day). */
function shiftSpan(s) {
  const midnight = Date.parse(zonedMidnightUTC(s.date));
  const start = midnight + toMin(s.start_time) * 60000;
  let end = midnight + toMin(s.end_time) * 60000;
  if (end <= start) end += 24 * 3600000;
  return { start, end };
}

/**
 * For one site and day: each clock-in (cards from timecardsFor, with user_id) gets
 * { rota: 'HH:MM–HH:MM' | null, late_minutes, over_minutes, not_on_rota }, and `missing` lists people rostered
 * there whose shift has started but who haven't clocked in (on a finished day: didn't clock in at all).
 */
export function attendance(db, locationId, date, cards, now = Date.now()) {
  const shifts = db.prepare(`SELECT s.id, s.user_id, s.location_id, s.date, s.start_time, s.end_time, u.name
    FROM published_shifts s JOIN users u ON u.id = s.user_id WHERE s.date = ?`).all(date).map((s) => ({ ...s, ...shiftSpan(s) }));
  const used = new Set();
  const byCard = new Map();
  for (const t of [...cards].sort((a, b) => a.start - b.start)) {
    if (t.location_id !== locationId) continue;
    // Their shift that day, at this site if they have one here, starting closest to when they clocked in.
    const mine = shifts.filter((s) => s.user_id && s.user_id === t.user_id && !used.has(s.id));
    const here = mine.filter((s) => s.location_id === locationId);
    const pool = here.length ? here : mine;
    const shift = pool.sort((a, b) => Math.abs(a.start - t.start) - Math.abs(b.start - t.start))[0];
    if (!shift) {
      // Only someone Brewly knows can be "not on the rota" (an unlinked Square team member might be).
      byCard.set(t.id, { rota: null, late_minutes: 0, over_minutes: 0, not_on_rota: !!t.user_id });
      continue;
    }
    used.add(shift.id);
    const late = Math.floor((t.start - shift.start) / 60000);
    const out = t.end_at ? t.end : now;
    const over = Math.floor((out - shift.end) / 60000);
    byCard.set(t.id, {
      rota: `${shift.start_time}–${shift.end_time}`,
      late_minutes: late >= 1 ? late : 0,
      // Clocked out (or still clocked in) more than 5 minutes after the shift ended.
      over_minutes: over > CLOCK_OUT_GRACE ? over : 0,
      not_on_rota: false,
    });
  }
  const clockedIn = new Set(cards.filter((t) => t.user_id).map((t) => t.user_id));
  const missing = shifts
    .filter((s) => s.location_id === locationId && !used.has(s.id) && !clockedIn.has(s.user_id) && s.start <= now)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ name: s.name, rota: `${s.start_time}–${s.end_time}`, late_minutes: Math.floor((Math.min(now, s.end) - s.start) / 60000), shift_over: s.end <= now }));
  return { byCard, missing };
}
