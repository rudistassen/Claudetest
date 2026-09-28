import { requirePerm, resolveLocation } from '../auth.js';
import { clockedByDay, clockedByHour, clockedByWeekHour, dayKey, dayOfWeek, hoursWorkedBy, nowMinutes, pct, rotaByDay, rotaByWeekHour, salesByDay, timecardsFor } from '../metrics.js';
import { addDays, badRequest, BUSINESS_TZ, date, oneOf, round2, shiftHours, today } from '../util.js';

const MAX_REPORT_DAYS = 366;
// A clock-in more than this many minutes after the rostered start counts as late.
const LATE_MINUTES = 5;

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localTime = (ms) => timeFormat.format(new Date(ms));
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Trading dashboard: Square sales next to rostered labour and actual labour from Square clock-ins, by day, by
 * hour of the day, by site and by person.
 */
// Date range and sites for a report: admins see every site unless they pick one.
function reportScope(db, req, defaultDays) {
  const to = date(req.query.to, 'to') ?? today();
  const from = date(req.query.from, 'from') ?? addDays(to, -(defaultDays - 1));
  if (from > to) throw badRequest('from must be before to');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_REPORT_DAYS) throw badRequest(`Reports are limited to ${MAX_REPORT_DAYS} days`);
  const locations = req.user.role === 'admin' && !req.query.location_id
    ? db.prepare('SELECT id, name, square_location_id FROM locations WHERE active = 1 ORDER BY name').all()
    : [db.prepare('SELECT id, name, square_location_id FROM locations WHERE id = ?').get(resolveLocation(req, req.query.location_id))];
  return { from, to, locations, ids: locations.map((l) => l.id) };
}

export function registerTradingRoutes(router, db, square) {
  /**
   * Labour % by day of the week and hour of the day: labour cost ÷ net sales in each slot, added up over the
   * period. Only site-days with Square sales count, so closed or unsynced days don't skew it.
   */
  router.get('/trading/heatmap', requirePerm('sales.view'), (req, res) => {
    const { from, to, locations, ids } = reportScope(db, req, 28);
    const labourSynced = !!db.prepare('SELECT 1 FROM timecards LIMIT 1').get();
    const basis = oneOf(req.query.basis, 'basis', ['clocked', 'rostered']) ?? (labourSynced ? 'clocked' : 'rostered');
    const inList = ids.map(() => '?').join(', ');

    const salesDays = db.prepare(`SELECT DISTINCT location_id, date FROM sales_daily WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`)
      .all(from, to, ...ids);
    const hasSales = new Set(salesDays.map((r) => dayKey(r.location_id, r.date)));
    const daysPerWeekday = Array(7).fill(0);
    for (const d of new Set(salesDays.map((r) => r.date))) daysPerWeekday[dayOfWeek(d)]++;

    const sales = new Map();
    for (const r of db.prepare(`SELECT date, hour, SUM(net_sales) AS net, SUM(orders) AS orders FROM sales_hourly
      WHERE date BETWEEN ? AND ? AND location_id IN (${inList}) GROUP BY date, hour`).all(from, to, ...ids)) {
      const k = `${dayOfWeek(r.date)}|${r.hour}`;
      const v = sales.get(k) ?? { net: 0, orders: 0 };
      v.net += r.net;
      v.orders += r.orders;
      sales.set(k, v);
    }
    const labour = basis === 'clocked'
      ? clockedByWeekHour(timecardsFor(db, ids, from, to).filter((c) => hasSales.has(dayKey(c.location_id, c.date))))
      : rotaByWeekHour(db, ids, from, to, (l, d) => hasSales.has(dayKey(l, d)));

    const cell = (net, cost, hours, orders) => ({
      net_sales: round2(net),
      orders,
      labour_cost: round2(cost),
      labour_hours: round1(hours),
      labour_pct: pct(cost, net),
    });
    const hourSet = new Set();
    for (const [k, v] of sales) if (v.net || v.orders) hourSet.add(Number(k.split('|')[1]));
    for (const [k, v] of labour) if (v.hours >= 0.05) hourSet.add(Number(k.split('|')[1]));
    const hours = [...hourSet].sort((a, b) => a - b);

    const cells = [];
    const rowT = Array.from({ length: 7 }, () => ({ net: 0, cost: 0, hours: 0, orders: 0 }));
    const colT = new Map(hours.map((h) => [h, { net: 0, cost: 0, hours: 0, orders: 0 }]));
    for (let dow = 0; dow < 7; dow++) {
      for (const h of hours) {
        const sv = sales.get(`${dow}|${h}`) ?? { net: 0, orders: 0 };
        const lv = labour.get(`${dow}|${h}`) ?? { hours: 0, cost: 0 };
        if (!sv.net && !sv.orders && lv.hours < 0.05) continue;
        cells.push({ dow, hour: h, ...cell(sv.net, lv.cost, lv.hours, sv.orders) });
        for (const t of [rowT[dow], colT.get(h)]) {
          t.net += sv.net;
          t.cost += lv.cost;
          t.hours += lv.hours;
          t.orders += sv.orders;
        }
      }
    }
    const all = rowT.reduce((a, t) => ({ net: a.net + t.net, cost: a.cost + t.cost, hours: a.hours + t.hours, orders: a.orders + t.orders }), { net: 0, cost: 0, hours: 0, orders: 0 });

    res.json({
      from,
      to,
      basis,
      labour_synced: labourSynced,
      square_connected: !!square,
      unlinked: locations.filter((l) => !l.square_location_id).map((l) => l.name),
      days_per_weekday: daysPerWeekday,
      hours,
      cells,
      weekdays: rowT.map((t, dow) => ({ dow, ...cell(t.net, t.cost, t.hours, t.orders) })),
      hour_totals: hours.map((h) => { const t = colT.get(h); return { hour: h, ...cell(t.net, t.cost, t.hours, t.orders) }; }),
      totals: cell(all.net, all.cost, all.hours, all.orders),
    });
  });

  router.get('/trading', requirePerm('sales.view'), (req, res) => {
    const { from, to, locations, ids } = reportScope(db, req, 7);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

    const sales = salesByDay(db, ids, from, to);
    const rota = rotaByDay(db, ids, from, to, { toDate: true });
    const cards = timecardsFor(db, ids, from, to);
    const clocked = clockedByDay(cards);

    const summary = (locIds, dates) => {
      const t = { net: 0, orders: 0, rotaHours: 0, rotaCost: 0, clockHours: 0, clockCost: 0 };
      // Labour % and sales per labour hour only use days that have both sales and labour, so an unsynced
      // day or a missing rota doesn't read as 0% or 100%+.
      const both = { clockNet: 0, clockCost: 0, clockHours: 0, rotaNet: 0, rotaCost: 0 };
      for (const l of locIds) {
        for (const d of dates) {
          const k = dayKey(l, d);
          const s = sales.get(k);
          const r = rota.get(k);
          const c = clocked.get(k);
          t.net += s?.net_sales ?? 0;
          t.orders += s?.orders ?? 0;
          t.rotaHours += r?.hours ?? 0;
          t.rotaCost += r?.cost ?? 0;
          t.clockHours += c?.hours ?? 0;
          t.clockCost += c?.cost ?? 0;
          if (s && c?.hours > 0) {
            both.clockNet += s.net_sales;
            both.clockCost += c.cost;
            both.clockHours += c.hours;
          }
          if (s && r?.cost > 0) {
            both.rotaNet += s.net_sales;
            both.rotaCost += r.cost;
          }
        }
      }
      return {
        net_sales: round2(t.net),
        orders: t.orders,
        avg_spend: t.orders ? round2(t.net / t.orders) : null,
        rostered_hours: round1(t.rotaHours),
        rostered_cost: round2(t.rotaCost),
        clocked_hours: round1(t.clockHours),
        clocked_cost: round2(t.clockCost),
        hours_variance: round1(t.clockHours - t.rotaHours),
        labour_pct: pct(both.clockCost, both.clockNet),
        rostered_labour_pct: pct(both.rotaCost, both.rotaNet),
        sales_per_labour_hour: both.clockHours > 0 ? round2(both.clockNet / both.clockHours) : null,
      };
    };

    // Hour of the day, averaged over the days that had sales. Clocked hours in an hour ≈ people on the clock.
    const inList = ids.map(() => '?').join(', ');
    const tradingDays = db.prepare(`SELECT COUNT(DISTINCT date) AS n FROM sales_daily WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`)
      .get(from, to, ...ids).n;
    const salesDates = new Set(db.prepare(`SELECT DISTINCT location_id || '|' || date AS k FROM sales_daily WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`)
      .all(from, to, ...ids).map((r) => r.k));
    const hourSales = new Map(db.prepare(`SELECT hour, SUM(net_sales) AS net, SUM(orders) AS orders FROM sales_hourly
      WHERE date BETWEEN ? AND ? AND location_id IN (${inList}) GROUP BY hour`).all(from, to, ...ids).map((r) => [r.hour, r]));
    const hourLabour = clockedByHour(cards.filter((c) => salesDates.has(dayKey(c.location_id, c.date))));
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const s = hourSales.get(h);
      if (!s && hourLabour[h] < 0.05) continue;
      const net = s?.net ?? 0;
      hours.push({
        hour: h,
        avg_net_sales: tradingDays ? round2(net / tradingDays) : 0,
        avg_orders: tradingDays ? round1((s?.orders ?? 0) / tradingDays) : 0,
        avg_staff: tradingDays ? round1(hourLabour[h] / tradingDays) : 0,
        sales_per_labour_hour: hourLabour[h] > 0 ? round2(net / hourLabour[h]) : null,
      });
    }

    res.json({
      from,
      to,
      square_connected: !!square,
      labour_synced: !!db.prepare('SELECT 1 FROM timecards LIMIT 1').get(),
      unlinked: locations.filter((l) => !l.square_location_id).map((l) => l.name),
      totals: summary(ids, days),
      days: days.map((d) => ({ date: d, ...summary(ids, [d]) })),
      hours,
      trading_days: tradingDays,
      locations: locations.map((l) => ({ id: l.id, name: l.name, linked: !!l.square_location_id, ...summary([l.id], days) })),
      staff: staffComparison(db, ids, from, to, cards, locations),
      clocked_in: cards.filter((c) => !c.end_at).map((c) => ({
        name: c.name,
        location: locations.find((l) => l.id === c.location_id)?.name,
        since: localTime(c.start),
        hours: round1(c.hours),
      })),
      last_sync: db.prepare(`SELECT finished_at, message FROM square_sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get() ?? null,
    });
  });
}

// Rota against clock-ins for each person: hours, late starts, missed shifts and clock-ins with no shift.
function staffComparison(db, ids, from, to, cards, locations) {
  const now = today();
  const shifts = db.prepare(`SELECT s.user_id, s.location_id, s.date, s.start_time, s.end_time, s.break_minutes, u.name
    FROM published_shifts s JOIN users u ON u.id = s.user_id
    WHERE s.date BETWEEN ? AND ? AND s.date <= ? AND s.location_id IN (${ids.map(() => '?').join(', ')})`).all(from, to, now, ...ids);
  const people = new Map();
  const person = (k, name, locationId) => {
    if (!people.has(k)) {
      people.set(k, { name, location: locations.find((l) => l.id === locationId)?.name ?? '', rostered_hours: 0, clocked_hours: 0, shifts: 0, clock_ins: 0, late: 0, missed: 0, unrostered: 0, late_minutes: 0 });
    }
    return people.get(k);
  };
  const byDay = new Map();
  const dayOf = (k, d) => {
    const dk = `${k}|${d}`;
    if (!byDay.has(dk)) byDay.set(dk, { shifts: [], cards: [] });
    return byDay.get(dk);
  };
  for (const s of shifts) {
    const k = `u${s.user_id}`;
    const p = person(k, s.name, s.location_id);
    // Today's shifts count up to now, to match clock-ins that are still open.
    p.rostered_hours += s.date === now ? hoursWorkedBy(s, nowMinutes()) : shiftHours(s.start_time, s.end_time, s.break_minutes);
    p.shifts += 1;
    dayOf(k, s.date).shifts.push(s);
  }
  for (const c of cards) {
    const k = c.user_id ? `u${c.user_id}` : `m${c.team_member_id}`;
    const p = person(k, c.name, c.location_id);
    p.clocked_hours += c.hours;
    p.clock_ins += 1;
    dayOf(k, c.date).cards.push(c);
  }
  for (const [dk, d] of byDay) {
    const p = people.get(dk.slice(0, dk.lastIndexOf('|')));
    if (!d.cards.length) {
      // Only count a shift as missed once it has started.
      const date = dk.slice(dk.lastIndexOf('|') + 1);
      const started = date < now || d.shifts.some((s) => toMin(s.start_time) <= nowMinutes());
      if (started) p.missed += d.shifts.length;
      continue;
    }
    if (!d.shifts.length) {
      p.unrostered += d.cards.length;
      continue;
    }
    const firstShift = Math.min(...d.shifts.map((s) => toMin(s.start_time)));
    const firstIn = toMin(localTime(Math.min(...d.cards.map((c) => c.start))));
    if (firstIn - firstShift > LATE_MINUTES) {
      p.late += 1;
      p.late_minutes += firstIn - firstShift;
    }
  }
  return [...people.values()]
    .map((p) => ({ ...p, rostered_hours: round1(p.rostered_hours), clocked_hours: round1(p.clocked_hours), variance: round1(p.clocked_hours - p.rostered_hours) }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.name.localeCompare(b.name));
}
