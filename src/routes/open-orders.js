// Reporting → Open orders: tabs and tickets started on the tills but not paid yet, read live from Square, with
// each order's items on request. Payment links sent from Brewly (they have their own page) and online orders
// (Square Online, delivery apps, pickup and delivery) are left out.
import { reportLocations, requirePerm } from '../auth.js';
import { isOnlineOrder } from '../square.js';
import { addDays, badRequest, localDate, notFound, num, round2, today, zonedMidnightUTC } from '../util.js';

const money = (m) => (m?.amount ?? 0) / 100;
const localTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const itemName = (li) => li.name || 'Custom amount';

export function registerOpenOrderRoutes(router, db, square) {
  const needSquare = () => { if (!square) throw badRequest('Square isn’t connected yet (Setup → Square).'); };
  const linkOrders = () => new Set(db.prepare('SELECT square_order_id FROM payment_links WHERE square_order_id IS NOT NULL').all().map((r) => r.square_order_id));

  // Open orders started in the last `days` days (1 = today), newest first.
  router.get('/open-orders', requirePerm('sales.view'), async (req, res) => {
    if (!square) return res.json({ square_ready: false, orders: [] });
    const days = num(req.query.days, 'days', { int: true, min: 1, max: 90 }) ?? 30;
    const sites = reportLocations(req, req.query.location_id).filter((l) => l.square_location_id);
    const bySquareId = new Map(sites.map((l) => [l.square_location_id, l]));
    const skip = linkOrders();
    const orders = [];
    if (sites.length) {
      const end = today();
      for await (const o of square.client.searchOrders({
        locationIds: [...bySquareId.keys()],
        startAt: zonedMidnightUTC(addDays(end, 1 - days)),
        endAt: zonedMidnightUTC(addDays(end, 1)),
        open: true,
      })) {
        const site = bySquareId.get(o.location_id);
        if (!site || skip.has(o.id) || isOnlineOrder(o)) continue;
        const items = (o.line_items ?? []).reduce((n, li) => n + (Number(li.quantity) || 0), 0);
        orders.push({
          id: o.id,
          location_id: site.id,
          location_name: site.name,
          created_at: o.created_at,
          date: localDate(o.created_at),
          time: localTime(o.created_at),
          name: o.ticket_name || o.reference_id || null,
          items: round2(items),
          summary: (o.line_items ?? []).slice(0, 3).map(itemName).join(', ') + ((o.line_items ?? []).length > 3 ? '…' : ''),
          amount: money(o.total_money),
          due: money(o.net_amount_due_money ?? o.total_money),
        });
      }
    }
    orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json({ square_ready: true, days, orders });
  });

  // One order's details: items (with options and notes), discounts, service charges, tax and any part payments.
  router.get('/open-orders/:id', requirePerm('sales.view'), async (req, res) => {
    needSquare();
    const orderId = String(req.params.id);
    if (!/^[\w-]{1,192}$/.test(orderId)) throw notFound('Order');
    const o = await square.client.getOrder(orderId).catch((err) => {
      if (/not.?found/i.test(err.message)) return null;
      throw err;
    });
    const site = o && db.prepare('SELECT id, name FROM locations WHERE square_location_id = ?').get(o.location_id);
    // Only orders at the person's own sites.
    if (!site || !req.user.site_ids.includes(site.id)) throw notFound('Order');
    res.json({
      id: o.id,
      state: o.state,
      location_id: site.id,
      location_name: site.name,
      name: o.ticket_name || o.reference_id || null,
      source: o.source?.name ?? null,
      created_at: o.created_at,
      updated_at: o.updated_at ?? null,
      date: localDate(o.created_at),
      time: localTime(o.created_at),
      updated_time: o.updated_at ? `${localDate(o.updated_at)} ${localTime(o.updated_at)}` : null,
      lines: (o.line_items ?? []).map((li) => ({
        name: itemName(li),
        variation: li.variation_name ?? null,
        quantity: Number(li.quantity) || 0,
        options: (li.modifiers ?? []).map((m) => m.name).filter(Boolean),
        note: li.note ?? null,
        total: money(li.total_money),
      })),
      discounts: (o.discounts ?? []).map((d) => ({ name: d.name || 'Discount', amount: money(d.applied_money ?? d.amount_money) })),
      service_charges: (o.service_charges ?? []).map((s) => ({ name: s.name || 'Service charge', amount: money(s.total_money ?? s.applied_money) })),
      tax: money(o.total_tax_money),
      total: money(o.total_money),
      paid: round2((o.tenders ?? []).reduce((n, t) => n + money(t.amount_money), 0)),
      due: money(o.net_amount_due_money ?? o.total_money),
    });
  });
}
