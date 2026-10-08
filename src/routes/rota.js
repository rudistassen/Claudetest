import { assertLocation, can, reportLocations, requirePerm, resolveLocation } from '../auth.js';
import { PUBLISH_COLUMNS, publishShifts, tx, UNPUBLISHED } from '../db.js';
import { availabilityOn } from '../availability.js';
import { leaveFor, onHoliday } from './leave.js';
import { notify, notifyOnce } from '../push.js';
import { dayKey, labourByDay, pct, rotaByDay, salesByDay } from '../metrics.js';
import { bankHoliday } from '../bank-holidays.js';
import { fmtDay, logRota, shiftChanges, shiftText } from '../rota-log.js';
import { notStarted, registerShiftDropRoutes, rotaDrops } from './shift-drops.js';
import { addDays, badRequest, date, id, notFound, num, oneOf, round2, shiftHours, str, time, today, weekStart, zonedMidnightUTC } from '../util.js';

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function range(s) {
  const start = toMin(s.start_time);
  let end = toMin(s.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export const FORECAST_WEEKS = 8;

/**
 * Expected sales for each site on each day of the week: the average of that weekday's net sales over the last
 * FORECAST_WEEKS weeks before the rota week (or before today, for a week that's still to come). Bank holidays and
 * days with no sales (closed, or before Square was connected) are left out. Returns
 * { weeks, from, to, sites: { [locationId]: [Mon..Sun: { avg, days } | null] } }.
 */
export function salesForecast(db, locationIds, weekStartDate) {
  const to = [addDays(weekStartDate, -1), addDays(today(), -1)].sort()[0];
  const from = addDays(to, -(FORECAST_WEEKS * 7 - 1));
  const sites = {};
  if (!locationIds.length) return { weeks: FORECAST_WEEKS, from, to, sites };
  const rows = db.prepare(`SELECT location_id, date, net_sales FROM sales_daily
    WHERE location_id IN (${locationIds.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? AND net_sales > 0`).all(...locationIds, from, to);
  const sums = new Map();
  for (const r of rows) {
    if (bankHoliday(r.date)) continue;
    const k = `${r.location_id}|${(new Date(`${r.date}T00:00:00Z`).getUTCDay() + 6) % 7}`;
    const v = sums.get(k) ?? { total: 0, days: 0 };
    v.total += r.net_sales;
    v.days += 1;
    sums.set(k, v);
  }
  for (const id of locationIds) {
    sites[id] = Array.from({ length: 7 }, (_, dow) => {
      const v = sums.get(`${id}|${dow}`);
      return v ? { avg: round2(v.total / v.days), days: v.days } : null;
    });
  }
  return { weeks: FORECAST_WEEKS, from, to, sites };
}

// Rota publishing: editors change a draft (the shifts table, where removed marks a published shift deleted in the
// draft) and staff see only what was last published (the published_shifts view). See db.js.
// The labour cost we aim for, as a share of net sales.
export const LABOUR_TARGET_PCT = 30;

export function registerRotaRoutes(router, db) {
  /**
   * Reporting → Rota costs: for a week, each site's rota cost against a labour budget of 30% of its forecast
   * sales (the average for each weekday over recent weeks, bank holidays left out). Uses the rota as it stands,
   * including changes not yet published; ?published=1 uses what staff can see.
   */
  router.get('/reports/rota-costs', requirePerm('sales.view'), (req, res) => {
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const locations = reportLocations(req, req.query.location_id);
    const ids = locations.map((l) => l.id);
    const published = req.query.published === '1';
    const rota = rotaByDay(db, ids, ws, addDays(ws, 6), { draft: !published });
    const forecast = salesForecast(db, ids, ws);
    const actual = salesByDay(db, ids, ws, addDays(ws, 6));
    const share = LABOUR_TARGET_PCT / 100;
    const line = (hours, cost, fc, sales) => ({
      hours: round2(hours),
      cost: round2(cost),
      forecast: fc === null ? null : round2(fc),
      budget: fc === null ? null : round2(fc * share),
      difference: fc === null ? null : round2(cost - fc * share),
      labour_pct: fc ? pct(cost, fc) : null,
      actual_sales: sales === null ? null : round2(sales),
    });
    const sites = locations.map((l) => {
      const perDay = days.map((d, i) => {
        const r = rota.get(dayKey(l.id, d)) ?? { hours: 0, cost: 0 };
        const f = forecast.sites[l.id]?.[i];
        const a = actual.get(dayKey(l.id, d));
        return { date: d, bank_holiday: bankHoliday(d), ...line(r.hours, r.cost, f ? f.avg : null, a ? a.net_sales : null) };
      });
      const sum = (k) => perDay.reduce((n, x) => n + (x[k] ?? 0), 0);
      const hasForecast = perDay.some((x) => x.forecast !== null);
      const hasActual = perDay.some((x) => x.actual_sales !== null);
      return { id: l.id, name: l.name, days: perDay, ...line(sum('hours'), sum('cost'), hasForecast ? sum('forecast') : null, hasActual ? sum('actual_sales') : null) };
    });
    const total = (k) => sites.reduce((n, x) => n + (x[k] ?? 0), 0);
    const anyForecast = sites.some((x) => x.forecast !== null);
    const anyActual = sites.some((x) => x.actual_sales !== null);
    const byDay = days.map((d, i) => {
      const t = (k) => sites.reduce((n, x) => n + (x.days[i][k] ?? 0), 0);
      const withFc = sites.some((x) => x.days[i].forecast !== null);
      const withSales = sites.some((x) => x.days[i].actual_sales !== null);
      return { date: d, bank_holiday: bankHoliday(d), ...line(t('hours'), t('cost'), withFc ? t('forecast') : null, withSales ? t('actual_sales') : null) };
    });
    res.json({
      week: ws,
      target_pct: LABOUR_TARGET_PCT,
      published,
      forecast_weeks: forecast.weeks,
      forecast_from: forecast.from,
      forecast_to: forecast.to,
      unpublished: db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE location_id IN (${ids.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? AND (${UNPUBLISHED})`).get(...ids, ws, addDays(ws, 6)).n,
      sites,
      days: byDay,
      totals: line(total('hours'), total('cost'), anyForecast ? total('forecast') : null, anyActual ? total('actual_sales') : null),
    });
  });

  const select = (table) => `
    SELECT s.*, u.name AS user_name, l.name AS location_name
    FROM ${table} s JOIN users u ON u.id = s.user_id JOIN locations l ON l.id = s.location_id`;
  const shiftSelect = select('draft_shifts');

  // Double-booking is checked against the draft, which is what will be published.
  function findClash(shift, ignoreId = 0) {
    const others = db.prepare(`${shiftSelect} WHERE s.user_id = ? AND s.date = ? AND s.id != ?`)
      .all(shift.user_id, shift.date, ignoreId);
    const [a1, a2] = range(shift);
    return others.find((o) => {
      const [b1, b2] = range(o);
      return a1 < b2 && b1 < a2;
    });
  }

  registerShiftDropRoutes(router, db, { findClash, clearUndo: (req) => clearUndo(req) });

  // --- Undo: each editor's last unpublished change, until their next change or a publish (rota_undo) ---
  const rowsById = (ids) => (ids.length ? db.prepare(`SELECT * FROM shifts WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map((r) => ({ ...r })) : []);
  const shiftColumns = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
  const personName = (userId) => db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? 'Someone';
  function clearUndo(req) { db.prepare('DELETE FROM rota_undo WHERE user_id = ?').run(req.user.id); }
  /** Remembers a change for undo: before = the touched shifts' rows beforehand, created = ids of new shifts. */
  function rememberUndo(req, label, locationId, before, created = []) {
    const after = rowsById([...new Set([...before.map((r) => r.id), ...created])]);
    db.prepare(`INSERT INTO rota_undo (user_id, label, location_id, before, after, created) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, location_id = excluded.location_id, before = excluded.before,
        after = excluded.after, created = excluded.created, at = datetime('now')`)
      .run(req.user.id, label, locationId, JSON.stringify(before), JSON.stringify(after), JSON.stringify(created));
  }
  const undoFor = (userId) => db.prepare('SELECT label, at FROM rota_undo WHERE user_id = ?').get(userId) ?? null;

  router.post('/rota/undo', requirePerm('rota.edit'), (req, res) => {
    const u = db.prepare('SELECT * FROM rota_undo WHERE user_id = ?').get(req.user.id);
    if (!u) throw badRequest('There’s nothing to undo');
    const before = JSON.parse(u.before);
    const after = JSON.parse(u.after);
    const created = JSON.parse(u.created);
    // Only if those shifts are exactly as this change left them (nobody has edited or published them since).
    const now = rowsById([...new Set([...before.map((r) => r.id), ...created])]);
    const key = (r) => JSON.stringify(shiftColumns.map((c) => r[c] ?? null));
    const same = now.length === after.length && after.every((a) => { const n = now.find((r) => r.id === a.id); return n && key(n) === key(a); });
    if (!same) {
      clearUndo(req);
      throw badRequest('Those shifts have changed since (edited or published), so this can’t be undone any more.');
    }
    tx(db, () => {
      if (created.length) db.prepare(`DELETE FROM shifts WHERE id IN (${created.map(() => '?').join(', ')})`).run(...created);
      const put = db.prepare(`INSERT OR REPLACE INTO shifts (${shiftColumns.join(', ')}) VALUES (${shiftColumns.map(() => '?').join(', ')})`);
      for (const r of before) put.run(...shiftColumns.map((c) => r[c] ?? null));
      clearUndo(req);
      logRota(db, req, { action: 'undo', location_id: u.location_id, details: `Undid: ${u.label}` });
    });
    res.json({ undone: u.label });
  });

  function shiftBody(req) {
    const b = req.body;
    const s = {
      location_id: resolveLocation(req, b.location_id),
      user_id: id(b.user_id, 'user_id', { required: true }),
      date: date(b.date, 'date', { required: true }),
      start_time: time(b.start_time, 'start_time', { required: true }),
      end_time: time(b.end_time, 'end_time', { required: true }),
      break_minutes: num(b.break_minutes, 'break_minutes', { min: 0, max: 600, int: true }) ?? 0,
      position: str(b.position, 'position', { max: 100 }),
      notes: str(b.notes, 'notes'),
    };
    if (s.start_time === s.end_time) throw badRequest('Shift start and end cannot be the same');
    const person = db.prepare('SELECT name FROM users WHERE id = ? AND active = 1').get(s.user_id);
    if (!person) throw notFound('Staff member');
    const holiday = onHoliday(db, s.user_id, s.date);
    if (holiday) throw badRequest(`${person.name} is on holiday from ${holiday.start_date} to ${holiday.end_date}`);
    return s;
  }

  function assertNoClash(s, ignoreId) {
    const clash = findClash(s, ignoreId);
    if (clash) {
      throw badRequest(`${clash.user_name} already has a shift ${clash.start_time}–${clash.end_time} at ${clash.location_name} on ${clash.date}`);
    }
  }

  // location_id=all shows every site the user can access at once.
  function rotaSites(req, raw) {
    if (raw === 'all') return reportLocations(req).map((l) => l.id);
    return [resolveLocation(req, raw)];
  }

  /**
   * The shift window's quick times: a site's five most used shift times (each with the break it usually has), most
   * used first. Looks at 4 weeks either side of today (the rota is often planned ahead); if that doesn't give five,
   * at the last 6 months, then fills up with the most used times at the other sites this person can see.
   */
  router.get('/rota/common-times', requirePerm('rota.edit'), (req, res) => {
    const locationId = resolveLocation(req, req.query.location_id);
    const WANT = 5;
    const tally = (siteIds, from, to) => {
      const rows = db.prepare(`SELECT start_time, end_time, break_minutes, COUNT(*) AS n FROM draft_shifts
        WHERE location_id IN (${siteIds.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? GROUP BY start_time, end_time, break_minutes`)
        .all(...siteIds, from, to);
      const byTime = new Map();
      for (const r of rows) {
        const k = `${r.start_time}|${r.end_time}`;
        const t = byTime.get(k) ?? { start_time: r.start_time, end_time: r.end_time, count: 0, breaks: [] };
        t.count += r.n;
        t.breaks.push(r);
        byTime.set(k, t);
      }
      return [...byTime.values()].sort((a, b) => b.count - a.count || a.start_time.localeCompare(b.start_time));
    };
    const picked = new Map();
    const add = (list) => { for (const t of list) if (picked.size < WANT && !picked.has(`${t.start_time}|${t.end_time}`)) picked.set(`${t.start_time}|${t.end_time}`, t); };
    add(tally([locationId], addDays(today(), -28), addDays(today(), 28)));
    if (picked.size < WANT) add(tally([locationId], addDays(today(), -183), addDays(today(), 60)));
    const others = req.user.site_ids.filter((id) => id !== locationId);
    if (picked.size < WANT && others.length) add(tally(others, addDays(today(), -28), addDays(today(), 28)));
    res.json([...picked.values()]
      .map(({ breaks, ...t }) => ({ ...t, break_minutes: breaks.sort((a, b) => b.n - a.n)[0].break_minutes ?? 0 })));
  });

  router.get('/rota', requirePerm('rota.view', 'rota.edit'), (req, res) => {
    const all = req.query.location_id === 'all';
    const ids = rotaSites(req, req.query.location_id);
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const we = addDays(ws, 6);
    // Labour costs and pay rates only for people who can see sales or manage staff.
    const manager = can(req.user, 'sales.view') || can(req.user, 'staff.manage');
    // Editors see the draft, with each shift marked new, changed or removed; everyone else sees the published rota.
    const editor = can(req.user, 'rota.edit');
    const table = editor ? 'shifts' : 'published_shifts';
    const inList = ids.map(() => '?').join(', ') || 'NULL';

    const shifts = db.prepare(`${select(table)} WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(...ids, ws, we);
    const names = new Map(db.prepare('SELECT id, name FROM locations').all().map((l) => [l.id, l.name]));
    if (editor) {
      for (const s of shifts) {
        s.state = s.removed ? 'removed' : s.pub_date === null ? 'new'
          : s.pub_location_id !== s.location_id || s.pub_user_id !== s.user_id || s.pub_date !== s.date || s.pub_start_time !== s.start_time
            || s.pub_end_time !== s.end_time || s.pub_break_minutes !== s.break_minutes ? 'changed' : 'published';
        if (s.state === 'changed') {
          s.published = { date: s.pub_date, start_time: s.pub_start_time, end_time: s.pub_end_time, location_name: names.get(s.pub_location_id), moved: s.pub_user_id !== s.user_id };
        }
      }
    }
    const staff = db.prepare(`
      SELECT u.id, u.name, u.position, u.rota_group, u.role, u.hourly_rate, u.location_id, l.name AS location_name FROM users u
      LEFT JOIN locations l ON l.id = u.location_id
      WHERE (u.location_id IN (${inList}) AND u.active = 1) OR u.id IN (SELECT user_id FROM ${table} WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?)
      ORDER BY ${all ? "l.name IS NULL, l.name, " : ''}CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.name`).all(...ids, ...ids, ws, we);
    // On a single site's rota, the same people's shifts at other sites that week, so it's clear when they're not free.
    const staffIds = staff.map((u) => u.id);
    const away = all || !staffIds.length ? [] : db.prepare(`${select(editor ? 'draft_shifts' : 'published_shifts')}
      WHERE s.user_id IN (${staffIds.map(() => '?').join(', ')}) AND s.location_id NOT IN (${inList}) AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(...staffIds, ...ids, ws, we);

    const rates = new Map(staff.map((u) => [u.id, u.hourly_rate]));
    const byUser = {};
    let totalHours = 0;
    let totalCost = 0;
    for (const s of shifts) {
      s.hours = round2(shiftHours(s.start_time, s.end_time, s.break_minutes));
      // Removed shifts and sickness don't count towards hours or labour cost.
      if (s.removed || s.sick) continue;
      byUser[s.user_id] = round2((byUser[s.user_id] ?? 0) + s.hours);
      totalHours += s.hours;
      totalCost += s.hours * (rates.get(s.user_id) ?? 0);
    }
    for (const s of away) s.hours = round2(shiftHours(s.start_time, s.end_time, s.break_minutes));
    if (!manager) for (const u of staff) delete u.hourly_rate;

    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const drops = rotaDrops(db, ids, ws, we);
    let money;
    if (manager) {
      const sales = salesByDay(db, ids, ws, we);
      const planned = labourByDay(db, ids, ws, we, { draft: editor });
      const worked = labourByDay(db, ids, ws, we, { toDate: true, draft: editor });
      money = days.map((d) => {
        // Across sites, labour % only counts sites that have sales that day (as on the Sales page).
        let net = null;
        let plannedCost = 0;
        let workedCost = 0;
        for (const l of ids) {
          const k = dayKey(l, d);
          plannedCost += planned.get(k) ?? 0;
          const siteNet = sales.get(k)?.net_sales;
          if (siteNet === undefined) continue;
          net = (net ?? 0) + siteNet;
          workedCost += worked.get(k) ?? 0;
        }
        return {
          date: d,
          net_sales: net === null ? null : round2(net),
          labour_cost: round2(plannedCost),
          worked_cost: workedCost,
          labour_pct: net === null || !workedCost ? null : pct(workedCost, net),
        };
      });
    }
    const salesDays = money?.filter((m) => m.net_sales !== null && m.worked_cost > 0) ?? [];
    const weekSales = salesDays.reduce((s, m) => s + m.net_sales, 0);
    const weekWorked = salesDays.reduce((s, m) => s + m.worked_cost, 0);
    for (const m of money ?? []) delete m.worked_cost;

    res.json({
      location_id: all ? 'all' : ids[0],
      week_start: ws,
      days,
      daily_money: money,
      week_sales: manager ? round2(weekSales) : undefined,
      labour_pct: manager ? pct(weekWorked, weekSales) : undefined,
      staff,
      shifts,
      away_shifts: away,
      hours_by_user: byUser,
      total_hours: round2(totalHours),
      labour_cost: manager ? round2(totalCost) : undefined,
      // For people who plan the rota: holiday (approved and requested) and usual availability for the people shown.
      leave: editor || can(req.user, 'leave.manage') ? leaveFor(db, staffIds, ws, we) : undefined,
      availability: editor || can(req.user, 'leave.manage') ? availabilityOn(db, staffIds, ws, we) : undefined,
      // For editors: how many changes staff can't see yet, and whether this person may publish them.
      unpublished: editor ? db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ? AND (${UNPUBLISHED})`).get(...ids, ws, we).n : undefined,
      unpublished_by_site: editor ? Object.fromEntries(db.prepare(`SELECT location_id, COUNT(*) AS n FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ? AND (${UNPUBLISHED}) GROUP BY location_id`).all(...ids, ws, we).map((r) => [r.location_id, r.n])) : undefined,
      unpublished_by_day: editor ? Object.fromEntries(db.prepare(`SELECT date, location_id, COUNT(*) AS n FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ? AND (${UNPUBLISHED}) GROUP BY date, location_id`).all(...ids, ws, we).map((r) => [`${r.date}|${r.location_id}`, r.n])) : undefined,
      // Expected sales (average for each weekday, bank holidays left out), so the rota's labour % can be seen while planning.
      forecast: manager ? salesForecast(db, ids, ws) : undefined,
      bank_holidays: Object.fromEntries(days.map((d) => [d, bankHoliday(d)]).filter(([, n]) => n)),
      can_publish: editor ? can(req.user, 'rota.publish') : undefined,
      // Their last change, if it can still be undone.
      undo: editor ? undoFor(req.user.id) : undefined,
      // Dropped shifts that are open for anyone at the site to pick up, and shifts someone has asked to drop.
      open_shifts: drops.open,
      drop_requested: drops.pending_shift_ids,
    });
  });

  // Unpublished changes at one site in a date range.
  const pendingAt = (locationId, from, to) => db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ? AND (${UNPUBLISHED})`)
    .get(locationId, from, to).n;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Publish a site (or all sites) for a week, or with { date } just that day. Logged site by site.
  router.post('/rota/publish', requirePerm('rota.publish'), (req, res) => {
    const ids = rotaSites(req, req.body.location_id);
    const day = date(req.body.date, 'date');
    const ws = day ? null : weekStart(date(req.body.week, 'week', { required: true }));
    clearUndo(req);
    const [from, to, label] = day ? [day, day, fmtDay(day)] : [ws, addDays(ws, 6), `the week of ${fmtDay(ws)}`];
    let published = 0;
    const changed = new Set();
    const sitesDone = [];
    for (const id of ids) {
      const n = pendingAt(id, from, to);
      if (!n) continue;
      // Whose shifts change (including whoever a moved shift was published for), to let them know.
      for (const r of db.prepare(`SELECT user_id, pub_user_id FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ? AND (${UNPUBLISHED})`).all(id, from, to)) {
        changed.add(r.user_id);
        if (r.pub_user_id) changed.add(r.pub_user_id);
      }
      sitesDone.push(id);
      publishShifts(db, [id], from, to);
      logRota(db, req, { action: 'publish', location_id: id, details: `Published ${plural(n, 'change')} for ${label}` });
      published += n;
    }
    // Notifications: anyone whose shifts changed; and the first time a week is published at a site, everyone on it.
    const weekLabel = ws ? `w/c ${fmtDay(ws)}` : fmtDay(day);
    const url = `/#/rota?view=mine&week=${ws ?? weekStart(day)}`;
    notify(db, [...changed], 'shift_changed', { title: 'Your shifts have changed', body: `Your rota for ${weekLabel} has been updated – tap to see your shifts`, url, tag: `shifts-${ws ?? day}` });
    if (ws) {
      for (const id of sitesDone) {
        const site = db.prepare('SELECT name FROM locations WHERE id = ?').get(id)?.name ?? 'your site';
        for (const r of db.prepare('SELECT DISTINCT user_id FROM published_shifts WHERE location_id = ? AND date BETWEEN ? AND ?').all(id, from, to)) {
          if (changed.has(r.user_id)) continue;
          notifyOnce(db, `rota|${id}|${ws}|${r.user_id}`, [r.user_id], 'rota_published', { title: 'Rota published', body: `The ${site} rota for ${weekLabel} is out – tap to see your shifts`, url, tag: `rota-${ws}` });
        }
        // Those whose shifts changed have now had this week's notice too.
        for (const u of changed) db.prepare('INSERT OR IGNORE INTO push_sent (key) VALUES (?)').run(`rota|${id}|${ws}|${u}`);
      }
    }
    res.json({ published });
  });

  // Publish one shift on its own: staff see it (or stop seeing it, if it was removed) straight away.
  router.post('/shifts/:id/publish', requirePerm('rota.publish'), (req, res) => {
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!s) throw notFound('Shift');
    assertLocation(req, s.location_id);
    if (s.pub_location_id && s.pub_location_id !== s.location_id) assertLocation(req, s.pub_location_id);
    clearUndo(req);
    tx(db, () => {
      if (s.removed) db.prepare('DELETE FROM shifts WHERE id = ?').run(s.id);
      else db.prepare(`UPDATE shifts SET ${PUBLISH_COLUMNS} WHERE id = ?`).run(s.id);
      logRota(db, req, { action: 'publish_shift', location_id: s.location_id, shift: s, details: `${s.removed ? 'Published the removal of' : 'Published'} ${shiftText(s)}` });
    });
    notify(db, [s.user_id, s.pub_user_id], 'shift_changed', {
      title: s.removed ? 'Shift removed' : 'Your shifts have changed',
      body: `${fmtDay(s.date)} ${s.start_time}–${s.end_time}${s.removed ? ' is no longer on your rota' : ' – tap to see your shifts'}`,
      url: `/#/rota?view=mine&week=${weekStart(s.date)}`,
    });
    res.json({ published: 1, removed: !!s.removed });
  });

  // Throws away draft changes for the week: new shifts go, changed ones go back to what's published, removed come back.
  router.post('/rota/discard', requirePerm('rota.edit'), (req, res) => {
    const ids = rotaSites(req, req.body.location_id);
    const ws = weekStart(date(req.body.week, 'week', { required: true }));
    const where = `location_id IN (${ids.map(() => '?').join(', ')}) AND date BETWEEN ? AND ?`;
    const args = [...ids, ws, addDays(ws, 6)];
    const n = db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE ${where} AND (${UNPUBLISHED})`).get(...args).n;
    clearUndo(req);
    tx(db, () => {
      for (const id of ids) {
        const here = pendingAt(id, ws, addDays(ws, 6));
        if (here) logRota(db, req, { action: 'discard', location_id: id, details: `Discarded ${plural(here, 'unpublished change')} for the week of ${fmtDay(ws)}` });
      }
      db.prepare(`DELETE FROM shifts WHERE ${where} AND pub_date IS NULL`).run(...args);
      db.prepare(`UPDATE shifts SET location_id = pub_location_id, user_id = pub_user_id, date = pub_date, start_time = pub_start_time,
        end_time = pub_end_time, break_minutes = pub_break_minutes, removed = 0 WHERE ${where}`).run(...args);
    });
    res.json({ discarded: n });
  });

  // The change log (Rota → Rota changes): newest first, for the dates the changes were made. Filter by site, the
  // person whose shift it was, the kind of change, or one shift (?shift_id=, for its history).
  router.get('/rota/log', requirePerm('rota.edit', 'rota.publish'), (req, res) => {
    const shiftId = req.query.shift_id ? Number(req.query.shift_id) : null;
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -13);
    if (from > to) throw badRequest('from must be before to');
    const sqlTime = (d) => zonedMidnightUTC(d).replace('T', ' ').slice(0, 19);
    const ids = rotaSites(req, req.query.location_id || 'all');
    const where = [`location_id IN (${ids.map(() => '?').join(', ')})`];
    const args = [...ids];
    if (shiftId) { where.push('shift_id = ?'); args.push(shiftId); }
    else { where.push('at >= ? AND at < ?'); args.push(sqlTime(from), sqlTime(addDays(to, 1))); }
    if (req.query.staff_id) { where.push('staff_id = ?'); args.push(Number(req.query.staff_id)); }
    if (req.query.action) {
      const kind = oneOf(req.query.action, 'action', ['add', 'change', 'remove', 'restore', 'publish', 'discard', 'copy', 'drop', 'open', 'claim', 'withdraw', 'sick', 'holiday', 'timecard_site', 'timecard_breaks']);
      // "Published" covers publishing a whole rota and a single shift.
      if (kind === 'publish') where.push(`action IN ('publish', 'publish_shift')`);
      // "Dropped" covers approved and declined drop requests.
      else if (kind === 'drop') where.push(`action IN ('drop', 'drop_decline')`);
      else { where.push('action = ?'); args.push(kind); }
    }
    const LIMIT = 1000;
    const rows = db.prepare(`SELECT * FROM rota_log WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ${LIMIT + 1}`).all(...args);
    // People to filter by: anyone who appears in the log for these sites.
    const people = db.prepare(`SELECT DISTINCT staff_id AS id, staff_name AS name FROM rota_log
      WHERE staff_id IS NOT NULL AND location_id IN (${ids.map(() => '?').join(', ')}) ORDER BY staff_name`).all(...ids);
    res.json({ from, to, entries: rows.slice(0, LIMIT), more: rows.length > LIMIT, people });
  });

  // Your own upcoming shifts, as published.
  // Your own published shifts: the next two weeks, or with ?week= that week at every site. People who can see the
  // rota also get who else is on at the same site that day.
  router.get('/my-shifts', (req, res) => {
    const week = req.query.week ? weekStart(date(req.query.week, 'week')) : null;
    const from = week ?? today();
    const to = week ? addDays(week, 6) : addDays(from, 13);
    const mine = db.prepare(`${select('published_shifts')} WHERE s.user_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`)
      .all(req.user.id, from, to);
    const withOthers = week && can(req.user, 'rota.view');
    const others = db.prepare(`SELECT s.start_time, s.end_time, u.name FROM published_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.location_id = ? AND s.date = ? AND s.user_id != ? ORDER BY s.start_time, u.name`);
    const dropAsked = new Set(db.prepare(`SELECT shift_id FROM shift_drops WHERE dropped_by = ? AND status = 'pending'`).all(req.user.id).map((r) => r.shift_id));
    for (const s of mine) {
      s.hours = round2(shiftHours(s.start_time, s.end_time, s.break_minutes));
      // Whether they can ask to drop it, or already have.
      s.drop_requested = dropAsked.has(s.id);
      s.can_drop = !s.drop_requested && notStarted(s);
      if (withOthers) s.colleagues = others.all(s.location_id, s.date, req.user.id);
    }
    res.json(mine);
  });

  router.post('/shifts', requirePerm('rota.edit'), (req, res) => {
    const s = shiftBody(req);
    assertNoClash(s, 0);
    const r = tx(db, () => {
      const ins = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.location_id, s.user_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes);
      logRota(db, req, { action: 'add', location_id: s.location_id, shift: { ...s, id: ins.lastInsertRowid }, details: shiftText(s) });
      rememberUndo(req, `Added ${personName(s.user_id)}’s shift ${shiftText(s)}`, s.location_id, [], [Number(ins.lastInsertRowid)]);
      return ins;
    });
    res.status(201).json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(r.lastInsertRowid));
  });

  function loadShift(req) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw notFound('Shift');
    assertLocation(req, shift.location_id);
    return shift;
  }

  router.put('/shifts/:id', requirePerm('rota.edit'), (req, res) => {
    const existing = loadShift(req);
    const s = shiftBody(req);
    assertNoClash(s, existing.id);
    const changes = shiftChanges(db, existing, s);
    tx(db, () => {
      const before = rowsById([existing.id]);
      db.prepare(`UPDATE shifts SET location_id = ?, user_id = ?, date = ?, start_time = ?, end_time = ?, break_minutes = ?, position = ?, notes = ?, removed = 0 WHERE id = ?`)
        .run(s.location_id, s.user_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes, existing.id);
      rememberUndo(req, `Changed ${personName(existing.user_id)}’s shift ${shiftText(existing)}${existing.user_id !== s.user_id ? ` (gave it to ${personName(s.user_id)})` : ''}`, s.location_id, before);
      if (changes.length) {
        logRota(db, req, { action: 'change', location_id: s.location_id, shift: { ...s, id: existing.id }, details: `${shiftText(s)} — ${changes.join('; ')}` });
      }
    });
    res.json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(existing.id));
  });

  // A shift staff have never seen is deleted; a published one is marked removed until the rota is published.
  router.delete('/shifts/:id', requirePerm('rota.edit'), (req, res) => {
    const shift = loadShift(req);
    tx(db, () => {
      const before = rowsById([shift.id]);
      if (shift.pub_date === null) db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
      else db.prepare('UPDATE shifts SET removed = 1 WHERE id = ?').run(shift.id);
      logRota(db, req, { action: 'remove', location_id: shift.location_id, shift,
        details: `${shiftText(shift)}${shift.pub_date === null ? ' (never published)' : ' (staff see it until the rota is published)'}` });
      rememberUndo(req, `Removed ${personName(shift.user_id)}’s shift ${shiftText(shift)}`, shift.location_id, before);
    });
    res.json({ ok: true });
  });

  // Marks a shift as the person being off sick (or not, with { sick: false }). It applies straight away, to the
  // rota staff see too – it's a record of what happened, not a change waiting to be published.
  router.post('/shifts/:id/sickness', requirePerm('rota.edit'), (req, res) => {
    const shift = loadShift(req);
    const sick = req.body?.sick !== false;
    const note = sick ? str(req.body?.note, 'note', { max: 500 }) : null;
    clearUndo(req);
    tx(db, () => {
      db.prepare(`UPDATE shifts SET sick = ?, sick_note = ?, sick_by = ?, sick_at = ${sick ? "datetime('now')" : 'NULL'} WHERE id = ?`)
        .run(sick ? 1 : 0, note, sick ? req.user.id : null, shift.id);
      logRota(db, req, { action: 'sick', location_id: shift.location_id, shift,
        details: `${shiftText(shift)} — ${sick ? `marked as sick${note ? ` (“${note}”)` : ''}` : 'no longer marked as sick'}` });
    });
    res.json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(shift.id));
  });

  /**
   * Reporting → Sickness: every shift marked as sickness in the dates (default the last 90 days), newest first,
   * with each person's total days and hours off sick.
   */
  router.get('/reports/sickness', requirePerm('rota.edit', 'staff.manage'), (req, res) => {
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -89);
    if (from > to) throw badRequest('from must be before to');
    const ids = reportLocations(req, req.query.location_id).map((l) => l.id);
    const rows = db.prepare(`SELECT s.id, s.date, s.start_time, s.end_time, s.break_minutes, s.sick_note, s.sick_at, s.user_id, u.name AS user_name,
        s.location_id, l.name AS location_name, m.name AS marked_by
      FROM draft_shifts d JOIN shifts s ON s.id = d.id JOIN users u ON u.id = s.user_id JOIN locations l ON l.id = s.location_id
      LEFT JOIN users m ON m.id = s.sick_by
      WHERE s.sick = 1 AND s.date BETWEEN ? AND ? AND s.location_id IN (${ids.map(() => '?').join(', ')}) ORDER BY s.date DESC, s.start_time`)
      .all(from, to, ...ids)
      .map((r) => ({ ...r, hours: round2(shiftHours(r.start_time, r.end_time, r.break_minutes)) }));
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.user_id) ?? { user_id: r.user_id, name: r.user_name, days: new Set(), hours: 0, shifts: 0, last: r.date };
      p.days.add(r.date);
      p.hours += r.hours;
      p.shifts += 1;
      people.set(r.user_id, p);
    }
    const byPerson = [...people.values()].map((p) => ({ ...p, days: p.days.size, hours: round2(p.hours) }))
      .sort((a, b) => b.days - a.days || b.hours - a.hours || a.name.localeCompare(b.name));
    res.json({ from, to, shifts: rows, people: byPerson });
  });

  router.post('/shifts/:id/restore', requirePerm('rota.edit'), (req, res) => {
    const shift = loadShift(req);
    assertNoClash(shift, shift.id);
    if (onHoliday(db, shift.user_id, shift.date)) throw badRequest('They are on holiday that day');
    tx(db, () => {
      const before = rowsById([shift.id]);
      db.prepare('UPDATE shifts SET removed = 0 WHERE id = ?').run(shift.id);
      rememberUndo(req, `Put back ${personName(shift.user_id)}’s shift ${shiftText(shift)}`, shift.location_id, before);
      logRota(db, req, { action: 'restore', location_id: shift.location_id, shift, details: shiftText(shift) });
    });
    res.json(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(shift.id));
  });

  // Copies one week's shifts onto another, skipping any that would double-book someone.
  router.post('/rota/copy-week', requirePerm('rota.edit'), (req, res) => {
    const ids = rotaSites(req, req.body.location_id);
    const from = weekStart(date(req.body.from_week, 'from_week', { required: true }));
    const to = weekStart(date(req.body.to_week, 'to_week', { required: true }));
    if (from === to) throw badRequest('Choose a different week to copy to');
    const offset = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

    const result = tx(db, () => {
      const inList = ids.map(() => '?').join(', ') || 'NULL';
      const before = db.prepare(`SELECT * FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?`).all(...ids, to, addDays(to, 6)).map((r) => ({ ...r }));
      const created = [];
      if (req.body.replace) {
        db.prepare(`DELETE FROM shifts WHERE location_id IN (${inList}) AND date BETWEEN ? AND ? AND pub_date IS NULL`).run(...ids, to, addDays(to, 6));
        db.prepare(`UPDATE shifts SET removed = 1 WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?`).run(...ids, to, addDays(to, 6));
      }
      // Copied shifts are drafts until the week is published.
      const source = db.prepare(`SELECT s.* FROM draft_shifts s JOIN users u ON u.id = s.user_id
        WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ? AND u.active = 1 ORDER BY s.date, s.start_time`).all(...ids, from, addDays(from, 6));
      const insert = db.prepare(`INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let copied = 0;
      let skipped = 0;
      const bySite = new Map(ids.map((id) => [id, { copied: 0, skipped: 0 }]));
      for (const s of source) {
        const next = { ...s, date: addDays(s.date, offset) };
        const site = bySite.get(s.location_id);
        if (findClash(next, 0) || onHoliday(db, s.user_id, next.date)) { skipped++; if (site) site.skipped++; continue; }
        created.push(Number(insert.run(s.location_id, s.user_id, next.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes).lastInsertRowid));
        copied++;
        if (site) site.copied++;
      }
      for (const [id, n] of bySite) {
        if (!n.copied && !n.skipped && !req.body.replace) continue;
        logRota(db, req, { action: 'copy', location_id: id,
          details: `Copied ${plural(n.copied, 'shift')} from the week of ${fmtDay(from)} to the week of ${fmtDay(to)}${req.body.replace ? ', replacing that week' : ''}${n.skipped ? ` (${n.skipped} skipped: already booked or on holiday)` : ''}` });
      }
      rememberUndo(req, `Copied the week of ${fmtDay(from)} to the week of ${fmtDay(to)}${req.body.replace ? ', replacing it' : ''}`, ids.length === 1 ? ids[0] : null, before, created);
      return { copied, skipped };
    });
    res.json(result);
  });
}
