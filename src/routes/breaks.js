import { requirePerm } from '../auth.js';
import { breakInfo, breaksFor } from '../breaks.js';
import { timecardsFor } from '../metrics.js';
import { BUSINESS_TZ, round2 } from '../util.js';
import { reportScope } from './trading.js';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function registerBreakRoutes(router, db) {
  /** Reporting → Breaks: every clock-in in the dates with its breaks, and the ones that missed a proper break. */
  router.get('/breaks', requirePerm('sales.view', 'staff.manage'), (req, res) => {
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
