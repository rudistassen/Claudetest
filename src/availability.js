// Staff availability: what someone has said for particular days (unavailable or available, all day or between
// times), and repeating patterns (every 1, 2 or 4 weeks from a start date, to an optional end date). Anything set
// for a day replaces the pattern on that day.
import { addDays, weekStart } from './util.js';

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
export const weekdayOf = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Which week of a pattern a date falls in (0 for the week the pattern starts in), or null if it's outside it. */
export function patternWeek(pattern, iso) {
  if (iso < pattern.start_date || (pattern.end_date && iso > pattern.end_date)) return null;
  const weeks = Math.floor((dayNumber(weekStart(iso)) - dayNumber(weekStart(pattern.start_date))) / 7);
  return ((weeks % pattern.weeks) + pattern.weeks) % pattern.weeks;
}

const entry = (r, source) => ({ id: r.id, kind: r.kind, all_day: !!r.all_day, from_time: r.from_time, to_time: r.to_time, source, pattern_id: r.pattern_id ?? null });
const byTime = (a, b) => Number(b.all_day) - Number(a.all_day) || (a.from_time ?? '').localeCompare(b.from_time ?? '');

/** People's patterns, each with its slots. */
export function patternsFor(db, userIds) {
  if (!userIds.length) return [];
  const patterns = db.prepare(`SELECT * FROM availability_patterns WHERE user_id IN (${userIds.map(() => '?').join(', ')}) ORDER BY start_date, id`).all(...userIds);
  if (!patterns.length) return [];
  const slots = db.prepare(`SELECT * FROM availability_pattern_slots WHERE pattern_id IN (${patterns.map(() => '?').join(', ')}) ORDER BY week, weekday, all_day DESC, from_time`)
    .all(...patterns.map((p) => p.id));
  return patterns.map((p) => ({ ...p, slots: slots.filter((s) => s.pattern_id === p.id).map((s) => ({ ...s, all_day: !!s.all_day })) }));
}

/**
 * Each person's availability on each day from `from` to `to`:
 * { userId: { note, days: { 'YYYY-MM-DD': [{ kind, all_day, from_time, to_time, source: 'day' | 'pattern' }] } } }.
 * Days with nothing said are left out (available any time).
 */
export function availabilityOn(db, userIds, from, to) {
  const out = {};
  if (!userIds.length) return out;
  const list = userIds.map(() => '?').join(', ');
  for (const id of userIds) out[id] = { note: null, days: {} };
  for (const u of db.prepare(`SELECT id, availability_note FROM users WHERE id IN (${list})`).all(...userIds)) out[u.id].note = u.availability_note;
  const dayRows = db.prepare(`SELECT * FROM availability_days WHERE user_id IN (${list}) AND date BETWEEN ? AND ?`).all(...userIds, from, to);
  const setDays = new Set(dayRows.map((r) => `${r.user_id}|${r.date}`));
  for (const r of dayRows) (out[r.user_id].days[r.date] ??= []).push(entry(r, 'day'));
  for (const p of patternsFor(db, userIds)) {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (setDays.has(`${p.user_id}|${d}`)) continue;
      const week = patternWeek(p, d);
      if (week === null) continue;
      for (const s of p.slots) {
        if (s.week === week && s.weekday === weekdayOf(d)) (out[p.user_id].days[d] ??= []).push(entry(s, 'pattern'));
      }
    }
  }
  for (const u of Object.values(out)) for (const list of Object.values(u.days)) list.sort(byTime);
  return out;
}
