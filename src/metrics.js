import { BUSINESS_TZ, localDate, localHour, round2, shiftHours, today } from './util.js';

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
 * Rostered hours and cost per site per day, keyed "locationId|date", from the published rota. Shifts marked as
 * sickness don't count.
 * Default: the full rota. With { toDate: true }, only hours worked so far count – today's shifts are cut off
 * at the current time and future days count nothing – so it can be compared fairly with sales so far.
 */
export function rotaByDay(db, locationIds, from, to, { toDate = false, asOf, draft = false } = {}) {
  const current = asOf ?? { date: today(), minutes: nowMinutes() };
  // The published rota, or with { draft: true } the one being edited.
  const rows = db.prepare(`SELECT s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, u.hourly_rate
    FROM ${draft ? 'draft_shifts' : 'published_shifts'} s JOIN users u ON u.id = s.user_id
    WHERE s.sick = 0 AND s.date BETWEEN ? AND ? AND s.location_id IN (${locationIds.map(() => '?').join(', ')})`).all(from, to, ...locationIds);
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
  return db.prepare(`SELECT t.*, COALESCE(u.name, m.name, 'Unknown team member') AS name, u.hourly_rate AS user_rate, COALESCE(u.paid_breaks, 0) AS paid_breaks
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

/** Day of the week of an ISO date, Monday = 0 … Sunday = 6. */
export const dayOfWeek = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

const addTo = (map, k, hours, cost) => {
  const v = map.get(k) ?? { hours: 0, cost: 0 };
  v.hours += hours;
  v.cost += cost;
  map.set(k, v);
};

/**
 * Clocked hours and cost by day of the week and local hour, keyed "dow|hour". Each part of a timecard counts
 * in the day and hour it was worked; unpaid breaks are spread evenly over the timecard.
 */
export function clockedByWeekHour(cards, tz = BUSINESS_TZ) {
  const out = new Map();
  for (const t of cards) {
    if (t.span <= 0) continue;
    const paidShare = t.hours / t.span;
    for (let at = t.start; at < t.end;) {
      const next = Math.min(t.end, (Math.floor(at / 3600000) + 1) * 3600000);
      const hours = ((next - at) / 3600000) * paidShare;
      addTo(out, `${dayOfWeek(localDate(at, tz))}|${localHour(at, tz)}`, hours, hours * t.rate);
      at = next;
    }
  }
  return out;
}

/**
 * Rostered hours and cost by day of the week and hour, keyed "dow|hour", for shifts whose site-day passes
 * include(locationId, date). Breaks are spread evenly over the shift; today only counts up to now.
 */
export function rotaByWeekHour(db, locationIds, from, to, include = () => true, asOf) {
  const current = asOf ?? { date: today(), minutes: nowMinutes() };
  const rows = db.prepare(`SELECT s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, u.hourly_rate
    FROM published_shifts s JOIN users u ON u.id = s.user_id
    WHERE s.sick = 0 AND s.date BETWEEN ? AND ? AND s.date <= ? AND s.location_id IN (${locationIds.map(() => '?').join(', ')})`)
    .all(from, to, current.date, ...locationIds);
  const out = new Map();
  for (const r of rows) {
    if (!include(r.location_id, r.date)) continue;
    const start = toMin(r.start_time);
    let end = toMin(r.end_time);
    if (end <= start) end += 24 * 60;
    const paidShare = Math.max(0, 1 - (r.break_minutes || 0) / (end - start));
    const stop = r.date === current.date ? Math.min(end, current.minutes) : end;
    const dow = dayOfWeek(r.date);
    for (let m = start; m < stop;) {
      const next = Math.min(stop, (Math.floor(m / 60) + 1) * 60);
      const hours = ((next - m) / 60) * paidShare;
      // A shift running past midnight counts its late hours on the next day.
      addTo(out, `${(dow + Math.floor(m / 1440)) % 7}|${Math.floor(m / 60) % 24}`, hours, hours * r.hourly_rate);
      m = next;
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

/** Each site's sales budget (net) for each day of a week: { siteId: [Mon … Sun amounts, null where none is set] }. */
export function salesBudgets(db, locationIds, weekStartDate) {
  const out = {};
  for (const id of locationIds) out[id] = Array(7).fill(null);
  if (!locationIds.length) return out;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${weekStartDate}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  for (const r of db.prepare(`SELECT location_id, date, amount FROM sales_budgets WHERE location_id IN (${locationIds.map(() => '?').join(', ')}) AND date BETWEEN ? AND ?`)
    .all(...locationIds, days[0], days[6])) out[r.location_id][days.indexOf(r.date)] = r.amount;
  return out;
}

export const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : null);

export { key as dayKey };
