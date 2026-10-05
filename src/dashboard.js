import { nowMinutes, pct, rotaByDay, timecardsFor } from './metrics.js';
import { breakInfo, breaksFor } from './breaks.js';
import { attendance } from './attendance.js';
import { addDays, BUSINESS_TZ, round2, today, weekStart, zonedMidnightUTC } from './util.js';

/** The checks a site does: shared checks (unless switched off there) plus the site's own. */
export function tasksAt(db, locationId) {
  return db.prepare(`SELECT * FROM safety_tasks WHERE active = 1 AND (location_id = ? OR (location_id IS NULL
      AND id NOT IN (SELECT task_id FROM safety_task_exclusions WHERE location_id = ?)))
    ORDER BY frequency, sort_order, title`).all(locationId, locationId);
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * A summary card for each site, as on the dashboard and in the emailed report. By default it covers today so
 * far; with { date, fullDay: true } a whole past day (e.g. yesterday, for a morning email). Sales and labour are
 * compared with the same weekday a week earlier, up to the same time of day.
 */
export function siteSummaries(db, { locations, seeSales = false, seeOrders = false, seeClockIns = false, date = today(), fullDay = false }) {
  const d = date;
  const ws = weekStart(d);
  const lastWeek = addDays(d, -7);
  const minutes = fullDay ? 24 * 60 : nowMinutes();
  const cutoff = Date.parse(zonedMidnightUTC(lastWeek)) + minutes * 60000;
  // Someone still clocked in counts up to now; on a finished day, up to midnight at the end of it.
  const dayEnd = fullDay ? Date.parse(zonedMidnightUTC(addDays(d, 1))) : Date.now();
  const ids = locations.map((l) => l.id);
  const labourSynced = !!db.prepare('SELECT 1 FROM timecards LIMIT 1').get();
  const cardsToday = ids.length && (seeSales || seeClockIns) ? timecardsFor(db, ids, d, d, dayEnd) : [];
  const cardsLastWeek = ids.length && seeSales && labourSynced
    ? timecardsFor(db, ids, lastWeek, lastWeek).map((t) => {
      // Only the part worked by this time last week, breaks taken off pro rata.
      const worked = Math.max(0, Math.min(t.end, cutoff) - t.start) / 3600000;
      const hours = t.span > 0 ? worked * (t.hours / t.span) : 0;
      return { ...t, hours, cost: hours * t.rate };
    })
    : [];
  const rotaToday = seeSales && !labourSynced && ids.length ? rotaByDay(db, ids, d, d, { toDate: true, asOf: { date: d, minutes } }) : new Map();
  const rotaLastWeek = seeSales && !labourSynced && ids.length ? rotaByDay(db, ids, lastWeek, lastWeek, { toDate: true, asOf: { date: lastWeek, minutes } }) : new Map();

  // Sales figures are only as fresh as the last Square sync.
  const salesSummary = (locationId) => {
    const todaySales = db.prepare('SELECT net_sales, gross_sales, orders, open_gross, open_orders FROM sales_daily WHERE location_id = ? AND date = ?').get(locationId, d);
    const lastDay = db.prepare('SELECT net_sales, gross_sales, orders FROM sales_daily WHERE location_id = ? AND date = ?').get(locationId, lastWeek);
    // Last week's net sales by this time, from its hourly sales (the current hour counted pro rata).
    const hour = Math.floor(minutes / 60);
    const lastNet = db.prepare(`SELECT COALESCE(SUM(CASE WHEN hour < ? THEN net_sales WHEN hour = ? THEN net_sales * ? ELSE 0 END), 0) AS net
      FROM sales_hourly WHERE location_id = ? AND date = ?`).get(hour, hour, (minutes % 60) / 60, locationId, lastWeek).net;
    // Hourly figures are net only, so last week's gross by now is its day's gross scaled the same way.
    const lastGross = lastDay && lastDay.net_sales ? lastDay.gross_sales * (lastNet / lastDay.net_sales) : 0;
    const sum = (list) => list.filter((t) => t.location_id === locationId).reduce((n, t) => n + t.cost, 0);
    const labourToday = labourSynced ? sum(cardsToday) : rotaToday.get(`${locationId}|${d}`)?.cost ?? 0;
    const labourLast = labourSynced ? sum(cardsLastWeek) : rotaLastWeek.get(`${locationId}|${lastWeek}`)?.cost ?? 0;
    return {
      sales_today: todaySales ? round2(todaySales.net_sales) : null,
      gross_today: todaySales ? round2(todaySales.gross_sales) : null,
      open_gross: todaySales ? round2(todaySales.open_gross ?? 0) : 0,
      open_orders: todaySales?.open_orders ?? 0,
      orders_today: todaySales?.orders ?? 0,
      last_week: lastDay ? { net: round2(lastNet), gross: round2(lastGross), labour_cost: round2(labourLast) } : { net: null, gross: null, labour_cost: round2(labourLast) },
      labour_cost_today: round2(labourToday),
      labour_basis: labourSynced ? 'clocked' : 'rostered',
      labour_pct_today: todaySales && labourToday ? pct(labourToday, todaySales.net_sales) : null,
    };
  };
  // Who clocked in at a site (from Square), with how long they've worked and the breaks they've taken.
  const breaksToday = seeClockIns ? breaksFor(db, cardsToday.map((t) => t.id)) : new Map();
  // …and each compared with their shift on the published rota (late in, late out, not on the rota).
  const attendanceAt = (locationId) => attendance(db, locationId, d, cardsToday, dayEnd);
  const clockIns = (locationId, att) => cardsToday.filter((t) => t.location_id === locationId).map((t) => ({
    id: t.id,
    name: t.name,
    start: timeFormat.format(new Date(t.start)),
    end: t.end_at ? timeFormat.format(new Date(t.end)) : null,
    hours: Math.round(t.hours * 100) / 100,
    ...breakInfo(t, breaksToday.get(t.id), dayEnd),
    ...(att.byCard.get(t.id) ?? {}),
  }));
  // Everyone on the published rota at a site today, each with where they are now: 'due' (not started yet),
  // 'in', 'on_break', 'done' (clocked out), 'late' (shift started, not clocked in), 'missed' (shift over, never
  // clocked in), 'elsewhere' (clocked in at another site) or 'rota' (no Square clock-ins to compare with).
  // Then everyone else actually clocked in here: covering from their rota at another site (in/on_break/done,
  // with rota_site), or with no shift at all ('extra').
  const siteName = new Map(locations.map((l) => [l.id, l.name]));
  const roster = (locationId, att) => {
    const out = att.shifts.map((s) => {
      const t = att.cardForShift.get(s.id);
      const base = { shift_id: s.id, name: s.name, rota: `${s.start_time}–${s.end_time}` };
      if (t) {
        const status = t.end_at ? 'done' : breakInfo(t, breaksToday.get(t.id), dayEnd).on_break ? 'on_break' : 'in';
        const late = att.byCard.get(t.id)?.late_minutes ?? 0;
        return { ...base, status, clock: `${timeFormat.format(new Date(t.start))}–${t.end_at ? timeFormat.format(new Date(t.end)) : 'now'}`, late_minutes: late };
      }
      if (!labourSynced) return { ...base, status: 'rota' };
      if (att.clockedIn.has(s.user_id)) {
        const other = cardsToday.find((c) => c.user_id === s.user_id && c.location_id !== locationId);
        if (other) return { ...base, status: 'elsewhere', where: siteName.get(other.location_id) ?? 'another site' };
      }
      if (s.start > dayEnd) return { ...base, status: 'due' };
      return { ...base, status: s.end <= dayEnd ? 'missed' : 'late', late_minutes: Math.floor((Math.min(dayEnd, s.end) - s.start) / 60000) };
    });
    for (const s of att.sick) out.push({ ...s, status: 'sick' });
    const listed = new Set(att.shifts.map((s) => att.cardForShift.get(s.id)?.id).filter(Boolean));
    for (const t of cardsToday) {
      if (t.location_id !== locationId || listed.has(t.id)) continue;
      const clock = `${timeFormat.format(new Date(t.start))}–${t.end_at ? timeFormat.format(new Date(t.end)) : 'now'}`;
      const info = att.byCard.get(t.id) ?? {};
      const rotaSite = att.shiftSiteForCard.get(t.id);
      if (rotaSite && rotaSite !== locationId) {
        const status = t.end_at ? 'done' : breakInfo(t, breaksToday.get(t.id), dayEnd).on_break ? 'on_break' : 'in';
        out.push({ name: t.name, rota: info.rota ?? null, rota_site: siteName.get(rotaSite) ?? 'another site', status, clock, late_minutes: info.late_minutes ?? 0 });
      } else {
        out.push({ name: t.name, rota: null, status: 'extra', clock, clocked_out: !!t.end_at });
      }
    }
    return out;
  };

  const cards = locations.map((loc) => {
    const tasks = tasksAt(db, loc.id);
    const checks = db.prepare('SELECT task_id, period, status FROM safety_checks WHERE location_id = ? AND period IN (?, ?)').all(loc.id, d, ws);
    const count = (freq, period) => {
      const taskIds = new Set(tasks.filter((t) => t.frequency === freq).map((t) => t.id));
      const done = checks.filter((c) => c.period === period && taskIds.has(c.task_id));
      return { due: taskIds.size, done: done.length, fails: done.filter((c) => c.status === 'fail').length };
    };
    const shiftsToday = db.prepare(`SELECT s.id, s.start_time, s.end_time, s.position, s.sick, u.name FROM published_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.location_id = ? AND s.date = ? ORDER BY s.start_time`).all(loc.id, d);
    const lastTake = db.prepare(`SELECT MAX(completed_at) AS at FROM stock_takes WHERE location_id = ? AND status = 'completed'`).get(loc.id).at;
    const takeInProgress = db.prepare(`SELECT id FROM stock_takes WHERE location_id = ? AND status = 'in_progress'`).get(loc.id)?.id ?? null;
    const wastage = db.prepare('SELECT COALESCE(SUM(total_cost), 0) AS total FROM wastage WHERE location_id = ? AND date BETWEEN ? AND ?')
      .get(loc.id, addDays(d, -6), d).total;
    const orders = seeOrders
      ? db.prepare(`SELECT status, COUNT(*) AS n FROM purchase_orders WHERE location_id = ? AND status IN ('draft', 'sent') GROUP BY status`).all(loc.id)
      : [];
    return {
      id: loc.id,
      name: loc.name,
      daily: count('daily', d),
      weekly: count('weekly', ws),
      shifts_today: shiftsToday,
      wastage_7d: round2(wastage),
      last_stock_take: lastTake,
      stock_take_in_progress: takeInProgress,
      orders_draft: orders.find((o) => o.status === 'draft')?.n ?? 0,
      orders_sent: orders.find((o) => o.status === 'sent')?.n ?? 0,
      ...(seeSales ? salesSummary(loc.id) : {}),
      ...(seeClockIns ? (() => {
        const att = attendanceAt(loc.id);
        // People missing from their shift only matter once Square clock-ins are coming through.
        return { clock_ins: clockIns(loc.id, att), not_clocked_in: labourSynced ? att.missing : [], sick: att.sick, roster: roster(loc.id, att) };
      })() : {}),
    };
  });
  return { date: d, week_start: ws, compare_date: lastWeek, full_day: fullDay, labour_synced: labourSynced, locations: cards };
}
