// Moving a clock-in (Square timecard) to another site, for when someone clocked in on the wrong site's till.
// The change is made in Square, so Square, payroll and Atlas's labour figures all agree, and it's recorded
// under Rota → Rota changes. A site that isn't in Square (e.g. an HQ) can't hold a timecard there, so a clock-in
// moved to one stays put in Square and Atlas just counts it at that site (timecard_allocations). Breaks can be added, changed or removed the same way.
import { requirePerm } from '../auth.js';
import { summariseTimecard } from '../square.js';
import { BUSINESS_TZ, badRequest, forbidden, HttpError, id, localDate, notFound, zonedTimeUTC } from '../util.js';

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

/** Stores Square's copy of a timecard (after Atlas changed it) over Atlas's, breaks included. */
function saveTimecard(db, cardId, tc, locationId) {
  const t = summariseTimecard(tc);
  db.prepare(`UPDATE timecards SET location_id = ?, date = ?, start_at = ?, end_at = ?, unpaid_break_minutes = ?, hourly_rate = ?, status = ?,
    breaks_synced = 1, synced_at = datetime('now') WHERE id = ?`)
    .run(locationId, t.date, t.start_at, t.end_at, t.unpaid_break_minutes, t.hourly_rate, t.status, cardId);
  db.prepare('DELETE FROM timecard_breaks WHERE timecard_id = ?').run(cardId);
  const ins = db.prepare('INSERT INTO timecard_breaks (timecard_id, start_at, end_at, is_paid, name) VALUES (?, ?, ?, ?, ?)');
  for (const b of t.breaks) ins.run(cardId, b.start_at, b.end_at, b.is_paid ? 1 : 0, b.name);
  return t;
}

const hhmm = (iso) => (iso ? timeFormat.format(new Date(iso)) : null);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_BREAKS = 10;

export function registerTimecardRoutes(router, db, square) {
  // A clock-in someone may change: it exists, Square is connected and it's at a site they have.
  const editable = (req) => {
    if (!square) throw badRequest('Square isn’t connected, so clock-ins can’t be changed');
    const card = db.prepare(`SELECT t.*, COALESCE(u.name, m.name) AS person FROM timecards t LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN square_team_members m ON m.id = t.team_member_id WHERE t.id = ?`).get(String(req.params.id));
    if (!card) throw notFound('Clock-in');
    if (!req.user.site_ids.includes(card.location_id)) throw forbidden('You can only change clock-ins at sites you manage');
    return card;
  };
  const refused = (err) => new HttpError(err.status ?? 502, `Square didn’t accept the change: ${err.message.replace(/^Square error: /, '')}`);

  // The clock-in's breaks as Square has them, and the kinds of break set up for its site.
  router.get('/timecards/:id/breaks', requirePerm('timecards.breaks'), async (req, res) => {
    const card = editable(req);
    const tc = await square.client.getTimecard(card.id);
    if (!tc) throw notFound('Clock-in in Square');
    const types = await square.client.listBreakTypes(tc.location_id);
    res.json({
      person: card.person ?? 'Someone',
      date: localDate(tc.start_at),
      start: hhmm(tc.start_at),
      end: hhmm(tc.end_at),
      open: !tc.end_at,
      breaks: (tc.breaks ?? []).map((b) => ({ id: b.id, break_type_id: b.break_type_id, name: b.name, start: hhmm(b.start_at), end: hhmm(b.end_at), is_paid: !!b.is_paid })),
      break_types: types.map((t) => ({ id: t.id, name: t.break_name, expected_duration: t.expected_duration, is_paid: !!t.is_paid })),
    });
  });

  // Saves the clock-in's breaks: the list sent is the full new list (breaks left out are removed).
  router.put('/timecards/:id/breaks', requirePerm('timecards.breaks'), async (req, res) => {
    const card = editable(req);
    const list = Array.isArray(req.body?.breaks) ? req.body.breaks : null;
    if (!list) throw badRequest('breaks is required');
    if (list.length > MAX_BREAKS) throw badRequest(`At most ${MAX_BREAKS} breaks`);
    const tc = await square.client.getTimecard(card.id);
    if (!tc) throw notFound('Clock-in in Square');
    const types = await square.client.listBreakTypes(tc.location_id);
    const existing = tc.breaks ?? [];
    const cardStart = Date.parse(tc.start_at);
    const cardEnd = tc.end_at ? Date.parse(tc.end_at) : Date.now();
    const day = localDate(tc.start_at);
    // A time on the clock-in's day (or the next morning, for a clock-in that runs past midnight).
    const at = (t, label) => {
      if (typeof t !== 'string' || !TIME.test(t)) throw badRequest(`${label} must be a time like 12:30`);
      let ms = zonedTimeUTC(day, t);
      if (ms < cardStart - 60000 && ms + 86400000 <= cardEnd + 60000) ms += 86400000;
      return ms;
    };

    const next = list.map((item, i) => {
      const n = `Break ${i + 1}`;
      const base = item.id ? existing.find((b) => b.id === item.id) : null;
      if (item.id && !base) throw badRequest(`${n} is no longer on this clock-in – reload and try again`);
      const typeId = item.break_type_id ?? base?.break_type_id;
      const type = types.find((t) => t.id === typeId);
      if (!type && !(base && typeId === base.break_type_id)) throw badRequest(types.length ? `${n}: choose a kind of break` : 'No kinds of break are set up for this site in Square yet (Square Dashboard → Staff → Settings → Breaks)');
      const start = at(item.start, `${n}’s start`);
      let end = null;
      if (item.end === null || item.end === undefined || item.end === '') {
        // Only a break that's still going (on a clock-in that's still going) can be left without an end.
        if (!(base && !base.end_at && !tc.end_at)) throw badRequest(`${n}: add an end time`);
      } else {
        end = at(item.end, `${n}’s end`);
        if (end <= start) throw badRequest(`${n} must end after it starts`);
      }
      if (start < cardStart - 60000 || (end ?? start) > cardEnd + 60000) {
        throw badRequest(`${n} must be within the clock-in (${hhmm(tc.start_at)}–${hhmm(tc.end_at) ?? 'now'})`);
      }
      return {
        ...(base ? { id: base.id } : {}),
        start_at: new Date(start).toISOString(),
        ...(end !== null ? { end_at: new Date(end).toISOString() } : {}),
        break_type_id: typeId,
        name: type?.break_name ?? base?.name,
        expected_duration: type?.expected_duration ?? base?.expected_duration,
        is_paid: type ? !!type.is_paid : !!base?.is_paid,
      };
    }).sort((a, b) => a.start_at.localeCompare(b.start_at));
    for (let i = 1; i < next.length; i++) {
      if (!next[i - 1].end_at || next[i].start_at < next[i - 1].end_at) throw badRequest('Breaks can’t overlap');
    }

    // What changed, in words, for the log.
    const text = (b) => `${b.name ?? 'Break'} ${hhmm(b.start_at)}–${hhmm(b.end_at) ?? 'now'}`;
    const changes = [];
    for (const b of next) {
      const was = b.id ? existing.find((x) => x.id === b.id) : null;
      if (!was) changes.push(`added ${text(b)}`);
      else if (text(was) !== text(b)) changes.push(`changed ${text(was)} to ${text(b)}`);
    }
    for (const b of existing) if (!next.some((x) => x.id === b.id)) changes.push(`removed ${text(b)}`);
    if (!changes.length) return res.json({ ok: true, changed: false });

    let updated;
    try {
      updated = await square.client.updateTimecard(card.id, { ...writable(tc, tc.location_id), breaks: next });
    } catch (err) {
      throw refused(err);
    }
    const t = saveTimecard(db, card.id, updated ?? { ...tc, breaks: next }, card.location_id);
    const hours = t.end_at ? Math.round(((Date.parse(t.end_at) - Date.parse(t.start_at)) / 3600000 - t.unpaid_break_minutes / 60) * 100) / 100 : null;
    const site = db.prepare('SELECT name FROM locations WHERE id = ?').get(card.location_id)?.name ?? null;
    db.prepare(`INSERT INTO rota_log (actor_id, actor_name, action, location_id, location_name, staff_id, staff_name, shift_date, hours, details)
      VALUES (?, ?, 'timecard_breaks', ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, req.user.name, card.location_id, site, card.user_id, card.person ?? 'Someone', t.date, hours,
        `Clock-in ${hhmm(t.start_at)}–${hhmm(t.end_at) ?? 'now'}: ${changes.join('; ')}`);
    res.json({ ok: true, changed: true, changes });
  });

  router.put('/timecards/:id/location', requirePerm('timecards.move'), async (req, res) => {
    if (!square) throw badRequest('Square isn’t connected, so clock-ins can’t be changed');
    const card = db.prepare(`SELECT t.*, COALESCE(u.name, m.name) AS person FROM timecards t LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN square_team_members m ON m.id = t.team_member_id WHERE t.id = ?`).get(String(req.params.id));
    if (!card) throw notFound('Clock-in');
    const to = id(req.body?.location_id, 'Site', { required: true });
    if (to === card.location_id) throw badRequest('It’s already at that site');
    // They need access to both the site it's at and the one it's moving to.
    for (const siteId of [card.location_id, to]) {
      if (!req.user.site_ids.includes(siteId)) throw forbidden('You can only move clock-ins between sites you manage');
    }
    const site = db.prepare('SELECT id, name, square_location_id, active FROM locations WHERE id = ?').get(to);
    if (!site?.active) throw notFound('Site');
    const fromName = db.prepare('SELECT name FROM locations WHERE id = ?').get(card.location_id)?.name ?? 'another site';
    // Already counted at a site that isn't in Square: the Atlas site whose Square location it's really at.
    const allocation = db.prepare('SELECT * FROM timecard_allocations WHERE timecard_id = ?').get(card.id);
    const squareSite = allocation?.square_site_id ?? card.location_id;
    const log = (t, details) => {
      const hours = t.end_at ? Math.round(((Date.parse(t.end_at) - Date.parse(t.start_at)) / 3600000 - t.unpaid_break_minutes / 60) * 100) / 100 : null;
      db.prepare(`INSERT INTO rota_log (actor_id, actor_name, action, location_id, location_name, staff_id, staff_name, shift_date, hours, details)
        VALUES (?, ?, 'timecard_site', ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, req.user.name, to, site.name, card.user_id, card.person ?? 'Someone', t.date, hours, details);
    };
    const times = (t) => `${timeFormat.format(new Date(t.start_at))}–${t.end_at ? timeFormat.format(new Date(t.end_at)) : 'still clocked in'}`;

    // A site that isn't in Square (or the Square site it's really at): only Atlas changes – the timecard stays
    // where it is in Square, and Atlas counts its hours and cost at the chosen site.
    if (!site.square_location_id || (allocation && to === squareSite)) {
      if (to === squareSite) db.prepare('DELETE FROM timecard_allocations WHERE timecard_id = ?').run(card.id);
      else {
        db.prepare(`INSERT INTO timecard_allocations (timecard_id, location_id, square_site_id, moved_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(timecard_id) DO UPDATE SET location_id = excluded.location_id, moved_by = excluded.moved_by, moved_at = datetime('now')`)
          .run(card.id, to, squareSite, req.user.id);
      }
      db.prepare('UPDATE timecards SET location_id = ? WHERE id = ?').run(to, card.id);
      log(card, `Clock-in ${times(card)} counted at ${site.name} instead of ${fromName}${to === squareSite ? '' : ' (in Atlas only – Square is unchanged)'}`);
      return res.json({ ok: true, location_id: to, location_name: site.name, from_name: fromName, brewly_only: true });
    }

    const current = await square.client.getTimecard(card.id);
    if (!current) throw notFound('Clock-in in Square');
    let updated;
    try {
      updated = await square.client.updateTimecard(card.id, writable(current, site.square_location_id));
    } catch (err) {
      throw new HttpError(err.status ?? 502, `Square didn’t accept the change: ${err.message.replace(/^Square error: /, '')}`);
    }
    db.prepare('DELETE FROM timecard_allocations WHERE timecard_id = ?').run(card.id);
    const t = saveTimecard(db, card.id, updated ?? { ...current, location_id: site.square_location_id }, to);
    log(t, `Clock-in ${times(t)} moved from ${fromName} to ${site.name}`);
    res.json({ ok: true, location_id: to, location_name: site.name, from_name: fromName });
  });
}
