import { assertLocation, can, reportLocations, requireAdmin, requirePerm, resolveLocation } from '../auth.js';
import { PUBLISH_COLUMNS, publishShifts, tx, UNPUBLISHED } from '../db.js';
import { availabilityOn } from '../availability.js';
import { leaveFor, onHoliday } from './leave.js';
import { notify, notifyOnce } from '../push.js';
import { dayKey, labourByDay, pct, rotaByDay, salesBudgets, salesByDay } from '../metrics.js';
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

// Net sales as a share of gross for a site (after discounts, less VAT), from its recent sales; with none, gross less
// 20% VAT. Used to turn a gross sales budget into the net figure labour % is worked out on.
const DEFAULT_NET_RATIO = 1 / 1.2;
const netRatio = (t) => (t && t.gross > 0 ? Math.min(1, t.net / t.gross) : DEFAULT_NET_RATIO);

/**
 * Expected sales for each site on each day of the week: the average of that weekday's sales over the last
 * FORECAST_WEEKS weeks before the rota week (or before today, for a week that's still to come). Bank holidays and
 * days with no sales (closed, or before Square was connected) are left out. Returns
 * { weeks, from, to, sites: { [locationId]: [Mon..Sun: { avg (net), gross, days } | null] }, ratios: { [locationId]: net ÷ gross } }.
 */
export function salesForecast(db, locationIds, weekStartDate) {
  const to = [addDays(weekStartDate, -1), addDays(today(), -1)].sort()[0];
  const from = addDays(to, -(FORECAST_WEEKS * 7 - 1));
  const sites = {};
  if (!locationIds.length) return { weeks: FORECAST_WEEKS, from, to, sites };
  const ratios = {};
  if (!locationIds.length) return { weeks: FORECAST_WEEKS, from, to, sites, ratios };
  const rows = db.prepare(`SELECT location_id, date, net_sales, gross_sales FROM sales_daily
    WHERE location_id IN (${locationIds.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? AND net_sales > 0`).all(...locationIds, from, to);
  const sums = new Map();
  const totals = new Map();
  for (const r of rows) {
    if (bankHoliday(r.date)) continue;
    const k = `${r.location_id}|${(new Date(`${r.date}T00:00:00Z`).getUTCDay() + 6) % 7}`;
    const v = sums.get(k) ?? { total: 0, gross: 0, days: 0 };
    v.total += r.net_sales;
    v.gross += r.gross_sales || r.net_sales;
    v.days += 1;
    sums.set(k, v);
    const t = totals.get(r.location_id) ?? { net: 0, gross: 0 };
    t.net += r.net_sales;
    t.gross += r.gross_sales || r.net_sales;
    totals.set(r.location_id, t);
  }
  for (const id of locationIds) {
    sites[id] = Array.from({ length: 7 }, (_, dow) => {
      const v = sums.get(`${id}|${dow}`);
      return v ? { avg: round2(v.total / v.days), gross: round2(v.gross / v.days), days: v.days } : null;
    });
    ratios[id] = netRatio(totals.get(id));
  }
  return { weeks: FORECAST_WEEKS, from, to, sites, ratios };
}

// Rota publishing: editors change a draft (the shifts table, where removed marks a published shift deleted in the
// draft) and staff see only what was last published (the published_shifts view). See db.js.
// The labour cost we aim for, as a share of net sales.
export const LABOUR_TARGET_PCT = 30;

export function registerRotaRoutes(router, db, { rotaReader = null, rotaAnalyst = null } = {}) {
  /**
   * Reporting → Rota costs: for a week, each site's rota cost against a labour budget of 30% of its planned net
   * sales. Sales are shown gross (what the business talks in): the sales budget for the day (Rota → Sales budget)
   * where one is set, otherwise the forecast (the average for that weekday over recent weeks, bank holidays left
   * out). Labour % and the labour budget use the net equivalent – a budget is turned into net with the site's own
   * net-to-gross ratio. Uses the rota as it stands, including changes not yet published; ?published=1 uses what
   * staff can see.
   */
  router.get('/reports/rota-costs', requirePerm('sales.view'), (req, res) => {
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const locations = reportLocations(req, req.query.location_id);
    const ids = locations.map((l) => l.id);
    const published = req.query.published === '1';
    const rota = rotaByDay(db, ids, ws, addDays(ws, 6), { draft: !published });
    const forecast = salesForecast(db, ids, ws);
    const budgets = salesBudgets(db, ids, ws);
    const actual = salesByDay(db, ids, ws, addDays(ws, 6));
    const share = LABOUR_TARGET_PCT / 100;
    const MONEY = ['forecast', 'forecast_net', 'sales_budget', 'sales_budget_net', 'actual_sales', 'actual_net_sales'];
    // x: { hours, cost, forecast, forecast_net, sales_budget, sales_budget_net, actual_sales, actual_net_sales, budgeted }
    const line = (x) => {
      const plan = x.sales_budget_net ?? null;
      const out = { hours: round2(x.hours), cost: round2(x.cost), budgeted: !!x.budgeted };
      for (const k of MONEY) out[k] = x[k] === null || x[k] === undefined ? null : round2(x[k]);
      return { ...out,
        budget: plan === null ? null : round2(plan * share),
        difference: plan === null ? null : round2(x.cost - plan * share),
        labour_pct: plan ? pct(x.cost, plan) : null };
    };
    // Adds up lines: money that's missing everywhere stays missing.
    const addUp = (list) => {
      const x = { hours: 0, cost: 0, budgeted: list.some((l) => l.budgeted) };
      for (const l of list) { x.hours += l.hours; x.cost += l.cost; }
      for (const k of MONEY) x[k] = list.some((l) => l[k] !== null) ? list.reduce((n, l) => n + (l[k] ?? 0), 0) : null;
      return line(x);
    };
    const sites = locations.map((l) => {
      const ratio = forecast.ratios[l.id];
      const perDay = days.map((d, i) => {
        const r = rota.get(dayKey(l.id, d)) ?? { hours: 0, cost: 0 };
        const f = forecast.sites[l.id]?.[i];
        const b = budgets[l.id][i];
        const a = actual.get(dayKey(l.id, d));
        return { date: d, bank_holiday: bankHoliday(d), ...line({
          hours: r.hours, cost: r.cost,
          forecast: f ? f.gross : null, forecast_net: f ? f.avg : null,
          sales_budget: b ?? (f ? f.gross : null), sales_budget_net: b !== null ? b * ratio : f ? f.avg : null, budgeted: b !== null,
          actual_sales: a ? a.gross_sales : null, actual_net_sales: a ? a.net_sales : null,
        }) };
      });
      return { id: l.id, name: l.name, net_ratio: round2(ratio * 10000) / 10000, days: perDay, ...addUp(perDay) };
    });
    const byDay = days.map((d, i) => ({ date: d, bank_holiday: bankHoliday(d), ...addUp(sites.map((x) => x.days[i])) }));
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
      totals: addUp(sites),
    });
  });

  /**
   * Rota → Sales budget: for a week, each site's forecast gross sales for each day (the guide, from recent weeks'
   * averages) and the gross sales budget set for it. A budget overrides the forecast on the rota and in Rota costs;
   * labour % uses its net equivalent (net_ratio × gross).
   */
  router.get('/sales-budgets', requirePerm('sales.view'), (req, res) => {
    const ws = weekStart(date(req.query.week, 'week') ?? today());
    const locations = reportLocations(req);
    const ids = locations.map((l) => l.id);
    const forecast = salesForecast(db, ids, ws);
    const budgets = salesBudgets(db, ids, ws);
    const saved = db.prepare(`SELECT location_id, updated_by, MAX(updated_at) AS updated_at FROM sales_budgets
      WHERE location_id IN (${ids.map(() => '?').join(', ')}) AND date BETWEEN ? AND ? GROUP BY location_id`).all(...ids, ws, addDays(ws, 6));
    res.json({
      week: ws,
      days: Array.from({ length: 7 }, (_, i) => ({ date: addDays(ws, i), bank_holiday: bankHoliday(addDays(ws, i)) })),
      forecast_weeks: forecast.weeks,
      forecast_from: forecast.from,
      forecast_to: forecast.to,
      target_pct: LABOUR_TARGET_PCT,
      sites: locations.map((l) => ({
        id: l.id, name: l.name,
        forecast: (forecast.sites[l.id] ?? []).map((f) => (f ? f.gross : null)),
        forecast_net: (forecast.sites[l.id] ?? []).map((f) => (f ? f.avg : null)),
        net_ratio: forecast.ratios[l.id],
        budget: budgets[l.id],
        updated_by: saved.find((x) => x.location_id === l.id)?.updated_by ?? null,
        updated_at: saved.find((x) => x.location_id === l.id)?.updated_at ?? null,
      })),
    });
  });

  // Saves budgets: { week, sites: [{ id, budget: [Mon … Sun amount, or null to use the forecast] }] }.
  router.put('/sales-budgets', requirePerm('sales.view'), (req, res) => {
    const ws = weekStart(date(req.body?.week, 'week', { required: true }));
    if (!Array.isArray(req.body?.sites)) throw badRequest('sites must be a list');
    const rows = req.body.sites.map((x, n) => {
      const locationId = resolveLocation(req, x.id);
      if (!Array.isArray(x.budget) || x.budget.length !== 7) throw badRequest(`sites[${n}].budget needs a figure (or nothing) for each day`);
      return { locationId, amounts: x.budget.map((v, i) => num(v, `sites[${n}].budget[${i}]`, { min: 0, max: 10000000 })) };
    });
    tx(db, () => {
      const del = db.prepare('DELETE FROM sales_budgets WHERE location_id = ? AND date = ?');
      const put = db.prepare(`INSERT INTO sales_budgets (location_id, date, amount, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (location_id, date) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, updated_at = datetime('now')`);
      for (const r of rows) {
        r.amounts.forEach((v, i) => {
          const d = addDays(ws, i);
          if (v === null || v === undefined) del.run(r.locationId, d);
          else put.run(r.locationId, d, round2(v), req.user.name);
        });
      }
    });
    res.json({ ok: true });
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

  // ---- Admins: read a rota from a photo or PDF with Claude, check it, then add the shifts as drafts ----

  const READ_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  const clean = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const timeOk = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t ?? ''));

  router.post('/rota/import/read', requireAdmin, async (req, res) => {
    if (!rotaReader) throw badRequest('Reading rotas needs ANTHROPIC_API_KEY (the same key as the invoice reader) – add it in Railway → Variables');
    const b = req.body ?? {};
    const mediaType = oneOf(b.media_type, 'media_type', READ_TYPES, { required: true });
    const data = String(b.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!data) throw badRequest('Choose a photo or PDF of the rota');
    if (data.length > 14 * 1024 * 1024) throw badRequest('That file is too big – keep photos and PDFs under 10 MB');
    const siteIds = rotaSites(req, b.location_id);
    const week = weekStart(date(b.week, 'week') ?? today());
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const sites = db.prepare(`SELECT id, name, opening_hours FROM locations WHERE id IN (${siteIds.map(() => '?').join(',')}) ORDER BY name`).all(...siteIds);
    const team = db.prepare(`SELECT u.id, u.name, u.rota_group, u.position, u.location_id, l.name AS site FROM users u LEFT JOIN locations l ON l.id = u.location_id
      WHERE u.active = 1 AND u.role != 'admin' ORDER BY u.name`).all();
    const reading = await rotaReader.read({ media_type: mediaType, data }, {
      week: days, sites: sites.map((x) => ({ name: x.name, hours: x.opening_hours })), team: team.map((t) => ({ name: t.name, role: t.rota_group || t.position, site: t.site })),
    });
    if (!reading?.is_rota) throw badRequest('That doesn’t look like a rota – try a clearer photo, or the PDF');

    // Match names and sites to Atlas, and check each shift as it would be added.
    const byName = (n) => {
      const c = clean(n);
      if (!c) return null;
      const exact = team.filter((t) => clean(t.name) === c);
      if (exact.length === 1) return exact[0];
      const first = team.filter((t) => clean(t.name).replace(/\s*\(.*\)$/, '').split(' ')[0] === c.split(' ')[0]);
      return first.length === 1 ? first[0] : null;
    };
    const siteBy = (n) => sites.find((x) => clean(x.name) === clean(n)) ?? null;
    const seen = new Set();
    const proposals = (reading.shifts ?? []).map((r, i) => {
      const who = byName(r.person) ?? byName(r.written_as);
      const site = siteBy(r.site) ?? (sites.length === 1 ? sites[0] : sites.find((x) => x.id === who?.location_id) ?? null);
      const p = {
        key: i, written_as: r.written_as || r.person || '', unsure: r.unsure || '', notes: r.notes || '', position: r.role || '',
        user_id: who?.id ?? null, user_name: who?.name ?? null, location_id: site?.id ?? null, location_name: site?.name ?? null,
        date: r.date, start_time: r.start_time, end_time: r.end_time, break_minutes: Number.isInteger(r.break_minutes) ? r.break_minutes : 0,
      };
      let status = 'ready';
      let problem = '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date ?? '')) || !timeOk(p.start_time) || !timeOk(p.end_time) || p.start_time === p.end_time) {
        status = 'check'; problem = 'The day or times couldn’t be read clearly – check them';
      } else if (!p.user_id) {
        status = 'check'; problem = `Nobody matches “${p.written_as}” – choose who it is`;
      } else if (!p.location_id) {
        status = 'check'; problem = 'Choose which site this shift is at';
      } else {
        const dupKey = `${p.user_id}|${p.date}|${p.start_time}|${p.end_time}`;
        const existing = db.prepare('SELECT 1 FROM draft_shifts WHERE user_id = ? AND date = ? AND start_time = ? AND end_time = ?').get(p.user_id, p.date, p.start_time, p.end_time);
        const holiday = onHoliday(db, p.user_id, p.date);
        const clash = findClash(p);
        if (existing || seen.has(dupKey)) { status = 'exists'; problem = 'Already on the rota – it won’t be added twice'; }
        else if (holiday) { status = 'holiday'; problem = `${p.user_name} is on holiday then`; }
        else if (clash) { status = 'clash'; problem = `${p.user_name} already has ${clash.start_time}–${clash.end_time} at ${clash.location_name} that day`; }
        else if (!days.includes(p.date)) { status = 'check'; problem = 'This date isn’t in the week you’re looking at – check it'; }
        else if (p.unsure) { status = 'check'; problem = p.unsure; }
        seen.add(dupKey);
      }
      return { ...p, status, problem };
    });
    res.json({
      week, proposals, notes: reading.notes || '', demo: !!rotaReader.demo,
      team: team.map((t) => ({ id: t.id, name: t.name, location_id: t.location_id })),
      sites: sites.map((x) => ({ id: x.id, name: x.name })),
    });
  });

  // ---- Admins: analyse a week's rota (published and draft) against forecast sales, and suggest savings ----

  const toMins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  router.post('/rota/analyse', requireAdmin, async (req, res) => {
    if (!rotaAnalyst) throw badRequest('Analysing the rota needs ANTHROPIC_API_KEY (the same key as the invoice reader) – add it in Railway → Variables');
    const b = req.body ?? {};
    const ids = rotaSites(req, b.location_id);
    const ws = weekStart(date(b.week, 'week') ?? today());
    const we = addDays(ws, 6);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const inList = ids.map(() => '?').join(', ');
    const sites = db.prepare(`SELECT id, name, opening_hours FROM locations WHERE id IN (${inList}) ORDER BY name`).all(...ids);
    const forecast = salesForecast(db, ids, ws);
    const budgets = salesBudgets(db, ids, ws);
    const rates = new Map(db.prepare('SELECT id, hourly_rate FROM users').all().map((u) => [u.id, u.hourly_rate ?? 0]));
    const people = new Map(db.prepare('SELECT id, rota_group, position FROM users').all().map((u) => [u.id, u]));

    // What a usual hour of each weekday looks like at each site, over the same weeks as the forecast.
    const usual = new Map();
    const tradingDays = new Map();
    for (const h of db.prepare(`SELECT location_id, date, hour, net_sales, orders FROM sales_hourly WHERE location_id IN (${inList}) AND date BETWEEN ? AND ?`)
      .all(...ids, forecast.from, forecast.to)) {
      if (bankHoliday(h.date)) continue;
      const dow = (new Date(`${h.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const k = `${h.location_id}|${dow}|${h.hour}`;
      const v = usual.get(k) ?? { net: 0, orders: 0 };
      v.net += h.net_sales;
      v.orders += h.orders;
      usual.set(k, v);
      const dk = `${h.location_id}|${dow}`;
      tradingDays.set(dk, (tradingDays.get(dk) ?? new Set()).add(h.date));
    }

    // The rota as it will be once published (the draft, without removed shifts or sickness), and as staff see it now.
    const draft = db.prepare(`${select('shifts')} WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`).all(...ids, ws, we)
      .filter((s) => !s.removed && !s.sick);
    const published = db.prepare(`${select('published_shifts')} WHERE s.location_id IN (${inList}) AND s.date BETWEEN ? AND ?`).all(...ids, ws, we).filter((s) => !s.sick);
    const costOf = (s) => shiftHours(s.start_time, s.end_time, s.break_minutes) * (rates.get(s.user_id) ?? 0);
    const stateOf = (s) => (s.pub_date === null ? 'draft – not published yet'
      : ['location_id', 'user_id', 'date', 'start_time', 'end_time', 'break_minutes'].some((c) => s[`pub_${c}`] !== s[c]) ? 'draft – changed since published' : 'published');
    const byId = new Map(draft.map((s) => [s.id, s]));

    const week = {
      week_starting: ws,
      labour_target_pct: LABOUR_TARGET_PCT,
      sites: sites.map((l) => {
        const ratio = forecast.ratios[l.id];
        const siteDays = days.map((d, i) => {
          const f = forecast.sites[l.id]?.[i];
          const budget = budgets[l.id]?.[i] ?? null;
          const gross = budget ?? (f ? f.gross : null);
          const net = budget !== null ? budget * ratio : f ? f.avg : null;
          const shifts = draft.filter((s) => s.location_id === l.id && s.date === d);
          const cost = shifts.reduce((t, s) => t + costOf(s), 0);
          const n = tradingDays.get(`${l.id}|${i}`)?.size ?? 0;
          const onAt = (h) => shifts.filter((s) => Math.min(toMins(s.end_time), (h + 1) * 60) - Math.max(toMins(s.start_time), h * 60) >= 30).length;
          const hours = [];
          for (let h = 5; h < 24; h += 1) {
            const u = usual.get(`${l.id}|${i}|${h}`);
            const on = onAt(h);
            if (on || u) hours.push({ hour: `${String(h).padStart(2, '0')}:00`, people_on: on, usual_net_sales: u && n ? round2(u.net / n) : 0, usual_orders: u && n ? Math.round(u.orders / n) : 0 });
          }
          return {
            date: d,
            weekday: new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
            bank_holiday: bankHoliday(d) || null,
            forecast_gross_sales: gross === null ? null : round2(gross),
            forecast_net_sales: net === null ? null : round2(net),
            sales_figure_is: budget !== null ? 'manager’s sales budget' : f ? `average of the last ${f.days} ${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}s` : 'no forecast',
            labour_cost: round2(cost),
            labour_pct: net ? pct(cost, net) : null,
            hours,
            people_on_by_hour: Array.from({ length: 24 }, (_, h) => onAt(h)),
            shifts: shifts.map((s) => {
              const u = people.get(s.user_id);
              const hrs = shiftHours(s.start_time, s.end_time, s.break_minutes);
              return { id: s.id, person: s.user_name, role: u?.rota_group || u?.position || '', start_time: s.start_time, end_time: s.end_time,
                break_minutes: s.break_minutes, hours: round2(hrs), hourly_cost: round2(rates.get(s.user_id) ?? 0), cost: round2(costOf(s)), status: stateOf(s) };
            }),
          };
        });
        const cost = siteDays.reduce((t, d) => t + d.labour_cost, 0);
        const net = siteDays.some((d) => d.forecast_net_sales !== null) ? siteDays.reduce((t, d) => t + (d.forecast_net_sales ?? 0), 0) : null;
        const pubCost = published.filter((s) => s.location_id === l.id).reduce((t, s) => t + costOf(s), 0);
        return {
          name: l.name, opening_hours: l.opening_hours || 'not set', labour_target_pct: LABOUR_TARGET_PCT,
          week_forecast_net_sales: net === null ? null : round2(net), week_labour_cost: round2(cost), week_labour_pct: net ? pct(cost, net) : null,
          published_rota_labour_cost: round2(pubCost),
          days: siteDays,
        };
      }),
    };
    if (!draft.length) throw badRequest('There are no shifts on this week’s rota to analyse');

    const result = await rotaAnalyst.analyse(week);
    const siteByName = new Map(sites.map((l) => [l.name.toLowerCase(), l]));
    const timeOk2 = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t ?? ''));
    const recommendations = (result.recommendations ?? []).map((r) => {
      const shiftIds = (r.shift_ids ?? []).filter((x) => byId.has(x));
      const shifts = shiftIds.map((x) => byId.get(x));
      // Savings are worked out here where we can (rather than trusting Claude's arithmetic).
      let saving = typeof r.saving === 'number' ? r.saving : null;
      if (r.kind === 'cut_shift' && shifts.length) saving = shifts.reduce((t, s) => t + costOf(s), 0);
      if (shifts.length === 1 && (timeOk2(r.new_start_time) || timeOk2(r.new_end_time))) {
        const s = shifts[0];
        const start = timeOk2(r.new_start_time) ? r.new_start_time : s.start_time;
        const end = timeOk2(r.new_end_time) ? r.new_end_time : s.end_time;
        if (toMins(end) > toMins(start)) saving = costOf(s) - shiftHours(start, end, s.break_minutes) * (rates.get(s.user_id) ?? 0);
      }
      const site = siteByName.get(String(r.site ?? '').toLowerCase()) ?? sites.find((l) => l.id === shifts[0]?.location_id) ?? null;
      return {
        ...r, shift_ids: shiftIds, location_id: site?.id ?? null, site: site?.name ?? r.site,
        saving: saving === null ? null : round2(Math.max(0, saving)),
        shifts: shifts.map((s) => ({ id: s.id, user_name: s.user_name, date: s.date, start_time: s.start_time, end_time: s.end_time })),
      };
    });
    res.json({
      week: ws,
      demo: !!rotaAnalyst.demo,
      headline: result.headline ?? '',
      watch_outs: result.watch_outs ?? [],
      recommendations,
      total_saving: round2(recommendations.reduce((t, r) => t + (r.saving ?? 0), 0)),
      sites: week.sites.map((x, i) => ({ id: sites[i].id, name: x.name, forecast_net_sales: x.week_forecast_net_sales, labour_cost: x.week_labour_cost,
        labour_pct: x.week_labour_pct, published_labour_cost: x.published_rota_labour_cost,
        days: x.days.map((d) => ({ date: d.date, forecast_gross_sales: d.forecast_gross_sales, labour_cost: d.labour_cost, labour_pct: d.labour_pct })) })),
      target_pct: LABOUR_TARGET_PCT,
    });
  });

  // Adds the shifts an admin ticked: { shifts: [{ user_id, location_id, date, start_time, end_time, break_minutes, position, notes }] }.
  // They're drafts (staff don't see them until the rota is published); any that would double-book someone are skipped.
  router.post('/rota/import/apply', requireAdmin, (req, res) => {
    const list = Array.isArray(req.body?.shifts) ? req.body.shifts : [];
    if (!list.length) throw badRequest('Tick the shifts to add');
    if (list.length > 500) throw badRequest('Add at most 500 shifts at once');
    const added = [];
    const skipped = [];
    tx(db, () => {
      const insert = db.prepare('INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes, position, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const b of list) {
        try {
          const s = {
            location_id: resolveLocation(req, b.location_id),
            user_id: id(b.user_id, 'Person', { required: true }),
            date: date(b.date, 'Date', { required: true }),
            start_time: time(b.start_time, 'Start', { required: true }),
            end_time: time(b.end_time, 'End', { required: true }),
            break_minutes: num(b.break_minutes, 'Break', { min: 0, max: 600, int: true }) ?? 0,
            position: str(b.position, 'Role', { max: 100 }),
            notes: str(b.notes, 'Notes'),
          };
          if (s.start_time === s.end_time) throw badRequest('Start and end are the same');
          const person = db.prepare('SELECT name FROM users WHERE id = ? AND active = 1').get(s.user_id);
          if (!person) throw badRequest('That person isn’t on the team');
          if (onHoliday(db, s.user_id, s.date)) throw badRequest(`${person.name} is on holiday`);
          const clash = findClash(s);
          if (clash) throw badRequest(`${person.name} already has ${clash.start_time}–${clash.end_time} that day`);
          const r = insert.run(s.location_id, s.user_id, s.date, s.start_time, s.end_time, s.break_minutes, s.position, s.notes);
          logRota(db, req, { action: 'add', location_id: s.location_id, shift: { ...s, id: r.lastInsertRowid }, details: `${shiftText(s)} — from an uploaded rota` });
          added.push({ id: Number(r.lastInsertRowid), location_id: s.location_id });
        } catch (err) {
          skipped.push({ ...b, problem: err.message });
        }
      }
      if (added.length) rememberUndo(req, `Added ${added.length} shift${added.length === 1 ? '' : 's'} from an uploaded rota`, added[0].location_id, [], added.map((a) => a.id));
    });
    res.json({ added: added.length, ids: added.map((a) => a.id), skipped });
  });

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
        let gross = null;
        let plannedCost = 0;
        let workedCost = 0;
        for (const l of ids) {
          const k = dayKey(l, d);
          plannedCost += planned.get(k) ?? 0;
          const siteNet = sales.get(k)?.net_sales;
          if (siteNet === undefined) continue;
          net = (net ?? 0) + siteNet;
          gross = (gross ?? 0) + (sales.get(k)?.gross_sales ?? 0);
          workedCost += worked.get(k) ?? 0;
        }
        return {
          date: d,
          net_sales: net === null ? null : round2(net),
          gross_sales: gross === null ? null : round2(gross),
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
      week_gross_sales: manager ? round2((money ?? []).reduce((s, m) => s + (m.gross_sales ?? 0), 0)) : undefined,
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
      sales_budget: manager ? salesBudgets(db, ids, ws) : undefined,
      bank_holidays: Object.fromEntries(days.map((d) => [d, bankHoliday(d)]).filter(([, n]) => n)),
      can_publish: editor ? can(req.user, 'rota.publish') : undefined,
      // Their last change, if it can still be undone.
      undo: editor ? undoFor(req.user.id) : undefined,
      // Dropped shifts that are open for anyone to pick up, and shifts someone has asked to drop.
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
  // Deleting a shift takes it off straight away – including from what staff see – for anyone who can publish that
  // site's rota (Undo puts it back). For people who can only edit, a published shift is marked removed until someone
  // publishes, as before. A shift staff have never seen is simply deleted.
  router.delete('/shifts/:id', requirePerm('rota.edit'), (req, res) => {
    const shift = loadShift(req);
    const published = shift.pub_date !== null;
    const now = !published || (can(req.user, 'rota.publish') && (!shift.pub_location_id || req.user.site_ids.includes(shift.pub_location_id)));
    tx(db, () => {
      const before = rowsById([shift.id]);
      if (now) db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
      else db.prepare('UPDATE shifts SET removed = 1 WHERE id = ?').run(shift.id);
      logRota(db, req, { action: 'remove', location_id: shift.location_id, shift,
        details: `${shiftText(shift)}${!published ? ' (never published)' : now ? ' (taken off staff’s rota straight away)' : ' (staff see it until the rota is published)'}` });
      rememberUndo(req, `Removed ${personName(shift.user_id)}’s shift ${shiftText(shift)}`, shift.location_id, before);
    });
    // They could see it, so tell them it's gone (only for shifts still to come).
    if (published && now && shift.pub_date >= today()) {
      notify(db, [shift.pub_user_id], 'shift_changed', {
        title: 'Shift removed',
        body: `${fmtDay(shift.pub_date)} ${shift.pub_start_time}–${shift.pub_end_time} is no longer on your rota`,
        url: `/#/rota?view=mine&week=${weekStart(shift.pub_date)}`,
      });
    }
    res.json({ ok: true, removed_now: now });
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
