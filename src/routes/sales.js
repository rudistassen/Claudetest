import { reportLocations, requireAdmin, requirePerm } from '../auth.js';
import { dayKey, labourByDay, pct, salesByDay, wastageByDay } from '../metrics.js';
import { syncSales } from '../square.js';
import { applyTeamImport, fetchTeam, planTeamImport } from '../team.js';
import { applyCleanup, planCleanup } from '../cleanup.js';
import { addDays, badRequest, date, HttpError, notFound, round2, str, today } from '../util.js';

const MAX_SYNC_DAYS = 92;
const MAX_REPORT_DAYS = 366;

export function registerSalesRoutes(router, db, square) {
  const requireSquare = (_req, _res, next) =>
    next(square ? undefined : new HttpError(400, 'Square is not connected. Set SQUARE_ACCESS_TOKEN and restart the app.'));

  // --- Connection & location mapping (admin) ---

  router.get('/square/status', requirePerm('sales.view', 'sales.sync', 'staff.manage'), (_req, res) => {
    res.json({
      configured: !!square,
      environment: square?.config.environment ?? null,
      sync_minutes: square?.config.syncMinutes ?? null,
      mapped: db.prepare('SELECT id, name, square_location_id FROM locations WHERE square_location_id IS NOT NULL ORDER BY name').all(),
      last_sync: db.prepare(`SELECT * FROM square_sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get() ?? null,
      history: db.prepare('SELECT * FROM square_sync_log ORDER BY id DESC LIMIT 10').all(),
    });
  });

  router.get('/square/locations', requireAdmin, requireSquare, async (_req, res) => {
    const linked = new Map(db.prepare('SELECT id, name, square_location_id FROM locations WHERE square_location_id IS NOT NULL').all()
      .map((l) => [l.square_location_id, l]));
    const locations = await square.client.listLocations();
    res.json(locations.map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      address: [l.address?.address_line_1, l.address?.locality, l.address?.postal_code].filter(Boolean).join(', '),
      timezone: l.timezone,
      currency: l.currency,
      linked_location: linked.get(l.id) ?? null,
    })));
  });

  router.put('/locations/:id/square', requireAdmin, (req, res) => {
    const locationId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) throw notFound('Location');
    const squareId = str(req.body.square_location_id, 'square_location_id', { max: 64 });
    const taken = squareId && db.prepare('SELECT name FROM locations WHERE square_location_id = ? AND id != ?').get(squareId, locationId);
    if (taken) throw badRequest(`That Square location is already linked to ${taken.name}`);
    db.prepare('UPDATE locations SET square_location_id = ? WHERE id = ?').run(squareId, locationId);
    res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId));
  });

  // Creates a new site from a Square location and links the two.
  router.post('/square/import-location', requireAdmin, requireSquare, async (req, res) => {
    const squareId = str(req.body.square_location_id, 'square_location_id', { required: true, max: 64 });
    const loc = (await square.client.listLocations()).find((l) => l.id === squareId);
    if (!loc) throw notFound('Square location');
    if (db.prepare('SELECT 1 FROM locations WHERE square_location_id = ?').get(squareId)) throw badRequest('That Square location is already linked');
    const address = [loc.address?.address_line_1, loc.address?.locality, loc.address?.postal_code].filter(Boolean).join(', ') || null;
    const r = db.prepare('INSERT INTO locations (name, address, phone, square_location_id) VALUES (?, ?, ?, ?)')
      .run(loc.name, address, loc.phone_number ?? null, squareId);
    res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(r.lastInsertRowid));
  });

  // --- Staff from Square Team (admin): preview, then import ---

  const teamPlan = async (req) => {
    const team = await fetchTeam(square.client);
    return planTeamImport(db, team, { deactivateOthers: req.body?.deactivate_others === true || req.query.deactivate_others === 'true', currentUserId: req.user.id });
  };
  const siteNames = () => new Map(db.prepare('SELECT id, name FROM locations').all().map((l) => [l.id, l.name]));

  router.get('/square/team', requireAdmin, requireSquare, async (req, res) => {
    const names = siteNames();
    res.json((await teamPlan(req)).map((r) => ({
      name: r.name,
      action: r.action,
      reason: r.reason ?? null,
      existing: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
      email: r.values?.email ?? r.user?.email ?? null,
      no_email: !!r.no_email,
      role: r.values?.role ?? r.user?.role ?? null,
      site: r.values ? (r.values.location_id ? names.get(r.values.location_id) : 'All (admin)') : null,
      position: r.values?.position ?? null,
      hourly_rate: r.values?.hourly_rate ?? null,
    })));
  });

  router.post('/square/import-staff', requireAdmin, requireSquare, async (req, res) => {
    const plan = await teamPlan(req);
    const counts = applyTeamImport(db, plan, { currentUserId: req.user.id });
    res.json({ ...counts, need_password: plan.filter((r) => r.action === 'create').map((r) => r.name) });
  });

  // --- Removing sites not linked to Square and staff not in the Square team (admin): preview, then delete ---

  router.get('/square/cleanup', requireAdmin, (req, res) => {
    res.json(planCleanup(db, { currentUserId: req.user.id }));
  });

  router.post('/square/cleanup', requireAdmin, (req, res) => {
    const removeLocations = req.body.remove_locations === true;
    const removeStaff = req.body.remove_staff === true;
    if (!removeLocations && !removeStaff) throw badRequest('Choose sites, staff or both to remove');
    res.json(applyCleanup(db, { currentUserId: req.user.id, removeLocations, removeStaff }));
  });

  router.post('/square/sync', requirePerm('sales.sync'), requireSquare, async (req, res) => {
    const to = date(req.body.to, 'to') ?? today();
    const from = date(req.body.from, 'from') ?? addDays(to, -1);
    if (from > to) throw badRequest('from must be before to');
    if (to > today()) throw badRequest('Cannot sync future dates');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_SYNC_DAYS) throw badRequest(`Sync at most ${MAX_SYNC_DAYS} days at a time`);
    if (req.user.role !== 'admin' && (Date.parse(to) - Date.parse(from)) / 86400000 > 7) throw badRequest('You can sync up to a week at a time');
    res.json(await syncSales(db, square.client, { from, to, triggeredBy: req.user.name }));
  });

  // --- Sales report: daily sales alongside labour and wastage (managers and admins) ---

  router.get('/sales', requirePerm('sales.view'), (req, res) => {
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -6);
    if (from > to) throw badRequest('from must be before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_REPORT_DAYS) throw badRequest(`Reports are limited to ${MAX_REPORT_DAYS} days`);

    const locations = reportLocations(req, req.query.location_id);
    const ids = locations.map((l) => l.id);
    const sales = salesByDay(db, ids, from, to);
    const labour = labourByDay(db, ids, from, to, { toDate: true });
    const wastage = wastageByDay(db, ids, from, to);

    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const sum = (map, locIds, dates, f = (v) => v) => {
      let t = 0;
      for (const l of locIds) for (const d of dates) { const v = map.get(dayKey(l, d)); if (v !== undefined) t += f(v); }
      return t;
    };
    const summary = (locIds, dates) => {
      const net = sum(sales, locIds, dates, (r) => r.net_sales);
      const orders = sum(sales, locIds, dates, (r) => r.orders);
      const labourCost = sum(labour, locIds, dates);
      const waste = sum(wastage, locIds, dates);
      // Compare labour with sales only on days that have both Square sales and a rota, so a missing rota
      // or an unsynced/closed day doesn't show up as 0% or 100%+ labour.
      let labourBoth = 0;
      let salesBoth = 0;
      for (const l of locIds) {
        for (const d of dates) {
          const k = dayKey(l, d);
          if (sales.has(k) && (labour.get(k) ?? 0) > 0) {
            labourBoth += labour.get(k);
            salesBoth += sales.get(k).net_sales;
          }
        }
      }
      return {
        net_sales: round2(net),
        gross_sales: round2(sum(sales, locIds, dates, (r) => r.gross_sales)),
        orders,
        avg_spend: orders ? round2(net / orders) : null,
        labour_cost: round2(labourCost),
        labour_pct: pct(labourBoth, salesBoth),
        wastage: round2(waste),
        wastage_pct: pct(waste, net),
      };
    };

    const topItems = db.prepare(`SELECT name, variation_name, SUM(quantity) AS quantity, SUM(net_sales) AS net_sales FROM sales_items
      WHERE date BETWEEN ? AND ? AND location_id IN (${ids.map(() => '?').join(', ')})
      GROUP BY item_key ORDER BY net_sales DESC LIMIT 20`).all(from, to, ...ids)
      .map((r) => ({ ...r, quantity: round2(r.quantity), net_sales: round2(r.net_sales) }));

    res.json({
      from,
      to,
      square_connected: !!square,
      unlinked: locations.filter((l) => !l.square_location_id).map((l) => l.name),
      totals: summary(ids, days),
      days: days.map((d) => ({ date: d, ...summary(ids, [d]) })),
      locations: locations.map((l) => ({ id: l.id, name: l.name, linked: !!l.square_location_id, ...summary([l.id], days) })),
      top_items: topItems,
      last_sync: db.prepare(`SELECT finished_at FROM square_sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get()?.finished_at ?? null,
    });
  });
}
