import { can, requirePerm } from '../auth.js';
import { breakInfo, breaksFor } from '../breaks.js';
import { timecardsFor } from '../metrics.js';
import { BUSINESS_TZ, round2 } from '../util.js';
import { reportScope } from './trading.js';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function registerBreakRoutes(router, db) {
  /**
   * Reporting → Timecards: every clock-in in the dates, one row each – who, where, their rota shift that day, clock
   * in and out, breaks and paid hours (and pay, for people who can see pay or sales). ?q= narrows it to names.
   */
  router.get('/reports/timecards', requirePerm('reports.timecards'), (req, res) => {
    const { from, to, locations, ids } = reportScope(db, req, 7);
    const siteName = new Map(locations.map((l) => [l.id, l.name]));
    const seePay = can(req.user, 'staff.pay') || can(req.user, 'sales.view');
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const now = Date.now();
    const cards = timecardsFor(db, ids, from, to, now).filter((t) => !q || t.name.toLowerCase().includes(q));
    const breaks = breaksFor(db, cards.map((t) => t.id));
    // Their published rota shift(s) that day at that site, to set the clock-in against.
    const rota = db.prepare('SELECT start_time, end_time FROM published_shifts WHERE user_id = ? AND location_id = ? AND date = ? ORDER BY start_time');
    const rows = cards.map((t) => {
      const info = breakInfo(t, breaks.get(t.id), now);
      const shifts = t.user_id ? rota.all(t.user_id, t.location_id, t.date) : [];
      const start = timeFormat.format(new Date(t.start));
      return {
        id: t.id,
        date: t.date,
        name: t.name,
        user_id: t.user_id,
        location_id: t.location_id,
        location_name: siteName.get(t.location_id),
        rota: shifts.length ? shifts.map((s) => `${s.start_time}–${s.end_time}`).join(', ') : null,
        // Minutes after the rota'd start they clocked in (negative = early), against the nearest shift that day.
        late_minutes: shifts.length ? (() => {
          const [h, m] = start.split(':').map(Number);
          const diffs = shifts.map((s) => { const [sh, sm] = s.start_time.split(':').map(Number); return (h * 60 + m) - (sh * 60 + sm); });
          return diffs.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
        })() : null,
        start,
        end: t.end_at ? timeFormat.format(new Date(t.end)) : null,
        open: !t.end_at,
        break_minutes: Math.round(info.break_minutes),
        paid_break_minutes: Math.round(info.paid_break_minutes),
        break_flag: info.break_flag,
        hours: round2(t.hours),
        rate: seePay ? t.rate : undefined,
        cost: seePay ? round2(t.cost) : undefined,
      };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    res.json({
      from, to,
      labour_synced: !!db.prepare('SELECT 1 FROM timecards LIMIT 1').get(),
      see_pay: seePay,
      rows,
      totals: {
        timecards: rows.length,
        people: new Set(rows.map((r) => r.user_id ?? r.name)).size,
        hours: round2(rows.reduce((n, r) => n + r.hours, 0)),
        cost: seePay ? round2(rows.reduce((n, r) => n + r.cost, 0)) : undefined,
      },
    });
  });

  /** Reporting → Breaks: every clock-in in the dates with its breaks, and the ones that missed a proper break. */
  router.get('/breaks', requirePerm('sales.view', 'staff.manage', 'reports.breaks'), (req, res) => {
    const { from, to, locations, ids } = reportScope(db, req, 7);
    const siteName = new Map(locations.map((l) => [l.id, l.name]));
    const now = Date.now();
    const cards = timecardsFor(db, ids, from, to, now);
    const breaks = breaksFor(db, cards.map((t) => t.id));
    const rows = cards.map((t) => {
      const info = breakInfo(t, breaks.get(t.id), now);
      return {
        id: t.id,
        date: t.date,
        name: t.name,
        location_id: t.location_id,
        location_name: siteName.get(t.location_id),
        start: timeFormat.format(new Date(t.start)),
        end: t.end_at ? timeFormat.format(new Date(t.end)) : null,
        worked_minutes: Math.round(t.hours * 60),
        paid_break_cost: round2((info.paid_break_minutes / 60) * t.rate),
        ...info,
      };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    res.json({
      from,
      to,
      labour_synced: !!db.prepare('SELECT 1 FROM timecards LIMIT 1').get(),
      rows,
      totals: {
        shifts: rows.length,
        breaks: sum((r) => r.breaks.length),
        break_minutes: sum((r) => r.break_minutes),
        paid_break_minutes: sum((r) => r.paid_break_minutes),
        paid_break_cost: round2(sum((r) => r.paid_break_cost)),
        flagged: rows.filter((r) => r.break_flag).length,
        unknown: rows.filter((r) => !r.breaks_known).length,
      },
    });
  });
}
