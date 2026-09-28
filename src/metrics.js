import { BUSINESS_TZ, localHour, round2, shiftHours, today } from './util.js';

const key = (locationId, date) => `${locationId}|${date}`;

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function nowMinutes(tz = BUSINESS_TZ) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':');
  return Number(h) * 60 + Number(m);
}

// Paid hours of a shift worked by minute `upTo` of its start day (break deducted pro rata).
export function hoursWorkedBy(s, upTo) {
  const start = toMin(s.start_time);
  let end = toMin(s.end_time);
  if (end <= start) end += 24 * 60;
  const length = end - start;
  const worked = Math.max(0, Math.min(end, upTo) - start);
  return (worked * (1 - Math.min(1, (s.break_minutes || 0) / length))) / 60;
}

/**
 * Rostered hours and cost per site per day, keyed "locationId|date".
 * Default: the full rota. With { toDate: true }, only hours worked so far count – today's shifts are cut off
 * at the current time and future days count nothing – so it can be compared fairly with sales so far.
 */
export function rotaByDay(db, locationIds, from, to, { toDate = false, asOf } = {}) {
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
    const v = out.get(k) ?? { hours: 0, cost: 0 };
    v.hours += hours;
    v.cost += hours * r.hourly_rate;
    out.set(k, v);
  }
  return out;
}

/** Rostered labour cost per site per day, keyed "locationId|date" (see rotaByDay for { toDate }). */
export function labourByDay(db, locationIds, from, to, opts = {}) {
  return new Map([...rotaByDay(db, locationIds, from, to, opts)].map(([k, v]) => [k, v.cost]));
}

/**
 * Square clock-ins (timecards) for the sites and dates, each with its paid hours and cost. A timecard that is
 * still open counts up to `now`. Cost uses Square's wage for the job, else the person's hourly rate in the app.
 */
export function timecardsFor(db, locationIds, from, to, now = Date.now()) {
  return db.prepare(`SELECT t.*, COALESCE(u.name, m.name, 'Unknown team member') AS name, u.hourly_rate AS user_rate
    FROM timecards t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN square_team_members m ON m.id = t.team_member_id
    WHERE t.date BETWEEN ? AND ? AND t.location_id IN (${locationIds.map(() => '?').join(', ')}) ORDER BY t.start_at`)
    .all(from, to, ...locationIds)
    .map((t) => {
      const start = Date.parse(t.start_at);
      const end = t.end_at ? Date.parse(t.end_at) : Math.max(start, now);
      const span = (end - start) / 3600000;
      const hours = Math.max(0, span - t.unpaid_break_minutes / 60);
      const rate = t.hourly_rate ?? t.user_rate ?? 0;
      return { ...t, start, end, span, hours, rate, cost: hours * rate };
    });
}

/** Clocked (actual) hours and cost per site per day, keyed "locationId|date". */
export function clockedByDay(cards) {
  const out = new Map();
  for (const t of cards) {
    const k = key(t.location_id, t.date);
    const v = out.get(k) ?? { hours: 0, cost: 0 };
    v.hours += t.hours;
    v.cost += t.cost;
    out.set(k, v);
  }
  return out;
}

/**
 * Paid clocked hours in each local hour of the day (0–23), summed over the given timecards. Unpaid breaks are
 * spread evenly over the timecard. Europe/London offsets are whole hours, so UTC hour boundaries are local ones.
 */
export function clockedByHour(cards, tz = BUSINESS_TZ) {
  const out = Array(24).fill(0);
  for (const t of cards) {
    if (t.span <= 0) continue;
    const paidShare = t.hours / t.span;
    for (let at = t.start; at < t.end;) {
      const next = Math.min(t.end, (Math.floor(at / 3600000) + 1) * 3600000);
      out[localHour(at, tz)] += ((next - at) / 3600000) * paidShare;
      at = next;
    }
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
