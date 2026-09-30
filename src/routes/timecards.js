// Moving a clock-in (Square timecard) to another site, for when someone clocked in on the wrong site's till.
// The change is made in Square, so Square, payroll and Brewly's labour figures all agree, and it's recorded
// under Team → Rota changes.
import { requirePerm } from '../auth.js';
import { summariseTimecard } from '../square.js';
import { BUSINESS_TZ, badRequest, forbidden, HttpError, id, notFound } from '../util.js';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Only the fields Square lets an app change on a timecard (it refuses read-only ones such as created_at).
function writable(tc, squareLocationId) {
  const out = {
    location_id: squareLocationId,
    start_at: tc.start_at,
    ...(tc.end_at ? { end_at: tc.end_at } : {}),
    ...(tc.wage ? { wage: tc.wage } : {}),
    ...(tc.breaks ? { breaks: tc.breaks } : {}),
    ...(tc.declared_cash_tip_money ? { declared_cash_tip_money: tc.declared_cash_tip_money } : {}),
    ...(tc.version !== undefined ? { version: tc.version } : {}),
  };
  if (tc.team_member_id) out.team_member_id = tc.team_member_id;
  if (tc.employee_id && !tc.team_member_id) out.employee_id = tc.employee_id;
  return out;
}

export function registerTimecardRoutes(router, db, square) {
  router.put('/timecards/:id/location', requirePerm('staff.manage'), async (req, res) => {
    if (!square) throw badRequest('Square isn’t connected, so clock-ins can’t be changed');
    const card = db.prepare(`SELECT t.*, COALESCE(u.name, m.name) AS person FROM timecards t LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN square_team_members m ON m.id = t.team_member_id WHERE t.id = ?`).get(String(req.params.id));
    if (!card) throw notFound('Clock-in');
    const to = id(req.body?.location_id, 'Site', { required: true });
    if (to === card.location_id) throw badRequest('It’s already at that site');
    // They need to manage staff at both the site it's at and the one it's moving to.
    for (const siteId of [card.location_id, to]) {
      if (!req.user.site_ids.includes(siteId)) throw forbidden('You can only move clock-ins between sites you manage');
    }
    const site = db.prepare('SELECT id, name, square_location_id, active FROM locations WHERE id = ?').get(to);
    if (!site?.active) throw notFound('Site');
    if (!site.square_location_id) throw badRequest(`${site.name} isn’t linked to a Square location yet (Setup → Square)`);
    const fromName = db.prepare('SELECT name FROM locations WHERE id = ?').get(card.location_id)?.name ?? 'another site';

    const current = await square.client.getTimecard(card.id);
    if (!current) throw notFound('Clock-in in Square');
    let updated;
    try {
      updated = await square.client.updateTimecard(card.id, writable(current, site.square_location_id));
    } catch (err) {
      throw new HttpError(err.status ?? 502, `Square didn’t accept the change: ${err.message.replace(/^Square error: /, '')}`);
    }
    const t = summariseTimecard(updated ?? { ...current, location_id: site.square_location_id });
    db.prepare(`UPDATE timecards SET location_id = ?, date = ?, start_at = ?, end_at = ?, unpaid_break_minutes = ?, hourly_rate = ?, status = ?, synced_at = datetime('now') WHERE id = ?`)
      .run(to, t.date, t.start_at, t.end_at, t.unpaid_break_minutes, t.hourly_rate, t.status, card.id);

    const times = `${timeFormat.format(new Date(t.start_at))}–${t.end_at ? timeFormat.format(new Date(t.end_at)) : 'still clocked in'}`;
    const hours = t.end_at ? Math.round(((Date.parse(t.end_at) - Date.parse(t.start_at)) / 3600000 - t.unpaid_break_minutes / 60) * 100) / 100 : null;
    db.prepare(`INSERT INTO rota_log (actor_id, actor_name, action, location_id, location_name, staff_id, staff_name, shift_date, hours, details)
      VALUES (?, ?, 'timecard_site', ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, req.user.name, to, site.name, card.user_id, card.person ?? 'Someone', t.date, hours, `Clock-in ${times} moved from ${fromName} to ${site.name}`);
    res.json({ ok: true, location_id: to, location_name: site.name, from_name: fromName });
  });
}
