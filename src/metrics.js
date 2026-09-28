import { BUSINESS_TZ, round2, shiftHours, today } from './util.js';

const key = (locationId, date) => `${locationId}|${date}`;

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function nowMinutes(tz = BUSINESS_TZ) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':');
  return Number(h) * 60 + Number(m);
}

// Paid hours of a shift worked by minute `upTo` of its start day (break deducted pro rata).
function hoursWorkedBy(s, upTo) {
  const start = toMin(s.start_time);
  let end = toMin(s.end_time);
  if (end <= start) end += 24 * 60;
  const length = end - start;
  const worked = Math.max(0, Math.min(end, upTo) - start);
  return (worked * (1 - Math.min(1, (s.break_minutes || 0) / length))) / 60;
}

/**
 * Labour cost per site per day, keyed "locationId|date".
 * Default: the full rostered cost. With { toDate: true }, only hours worked so far count – today's shifts are
 * cut off at the current time and future days cost nothing – so it can be compared fairly with sales so far.
 */
export function labourByDay(db, locationIds, from, to, { toDate = false, asOf } = {}) {
  const current = asOf ?? { date: today(), minutes: nowMinutes() };
  const rows = db.prepare(`SELECT s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, u.hourly_rate
    FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.date BETWEEN ? AND ? AND s.location_id IN (${locationIds.map(() => '?').join(', ')})`).all(from, to, ...locationIds);
  const out = new Map();
  for (const r of rows) {
    let hours = shiftHours(r.start_time, r.end_time, r.break_minutes);
    if (toDate && r.date > current.date) hours = 0;
    else if (toDate && r.date === current.date) hours = hoursWorkedBy(r, current.minutes);
    const k = key(r.location_id, r.date);
    out.set(k, (out.get(k) ?? 0) + hours * r.hourly_rate);
  }
  return out;
}

export function salesByDay(db, locationIds, from, to) {
  const rows = db.prepare(`SELECT * FROM sales_daily WHERE date BETWEEN ? AND ? AND location_id IN (${locationIds.map(() => '?').join(', ')})`)
    .all(from, to, ...locationIds);
  return new Map(rows.map((r) => [key(r.location_id, r.date), r]));
}

export function wastageByDay(db, locationIds, from, to) {
  const rows = db.prepare(`SELECT location_id, date, SUM(total_cost) AS total FROM wastage
    WHERE date BETWEEN ? AND ? AND location_id IN (${locationIds.map(() => '?').join(', ')}) GROUP BY location_id, date`)
    .all(from, to, ...locationIds);
  return new Map(rows.map((r) => [key(r.location_id, r.date), r.total]));
}

export const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : null);

export { key as dayKey };
