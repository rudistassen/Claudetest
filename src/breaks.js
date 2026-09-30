// Breaks taken during Square clock-ins (timecards): when they were, whether they were paid, and whether a long
// shift had a proper break. UK rules: an adult working more than 6 hours is entitled to one uninterrupted break of
// at least 20 minutes during the day.
import { BUSINESS_TZ } from './util.js';

export const BREAK_RULE = { shiftHours: 6, breakMinutes: 20 };

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hhmm = (ms) => timeFormat.format(new Date(ms));

/** The breaks recorded for these timecards, as a Map of timecard id → breaks in time order. */
export function breaksFor(db, timecardIds) {
  const out = new Map();
  if (!timecardIds.length) return out;
  // Looked up in batches so a long date range stays within SQLite's limit on query parameters.
  for (let i = 0; i < timecardIds.length; i += 500) {
    const ids = timecardIds.slice(i, i + 500);
    const rows = db.prepare(`SELECT * FROM timecard_breaks WHERE timecard_id IN (${ids.map(() => '?').join(', ')}) ORDER BY start_at`).all(...ids);
    for (const b of rows) {
      if (!out.has(b.timecard_id)) out.set(b.timecard_id, []);
      out.get(b.timecard_id).push(b);
    }
  }
  return out;
}

/**
 * Break details for one clock-in. card needs start and end (ms; an open clock-in ends at "now") and end_at (null
 * while still clocked in); breaks are its timecard_breaks rows.
 * flag: 'none' (worked over 6 hours with no break), 'short' (no single break of 20 minutes or more) or null.
 * breaks_known is false for clock-ins synced before break details were kept (re-syncing those days fills them in).
 */
export function breakInfo(card, breaks = [], now = Date.now()) {
  // Clock-ins synced before Brewly kept break details: only the unpaid total is known, so nothing is flagged.
  if (card.breaks_synced === 0) {
    const unpaid = Math.round(card.unpaid_break_minutes ?? 0);
    return { breaks: [], break_minutes: unpaid, paid_break_minutes: 0, unpaid_break_minutes: unpaid, on_break: false, break_flag: null, breaks_known: false };
  }
  const list = breaks.map((b) => {
    const start = Date.parse(b.start_at);
    const running = !b.end_at;
    const end = running ? Math.min(now, card.end) : Date.parse(b.end_at);
    return {
      start: hhmm(start),
      end: running ? null : hhmm(end),
      minutes: Math.max(0, Math.round((end - start) / 60000)),
      paid: !!b.is_paid,
      name: b.name ?? null,
      running,
    };
  });
  const sum = (xs) => xs.reduce((n, b) => n + b.minutes, 0);
  const longest = list.reduce((m, b) => Math.max(m, b.minutes), 0);
  const spanHours = (card.end - card.start) / 3600000;
  let flag = null;
  if (spanHours > BREAK_RULE.shiftHours) {
    if (!list.length) flag = 'none';
    // A break still running may yet reach 20 minutes, so it isn't called short until it ends.
    else if (longest < BREAK_RULE.breakMinutes && !list.some((b) => b.running)) flag = 'short';
  }
  return {
    breaks: list,
    break_minutes: sum(list),
    paid_break_minutes: sum(list.filter((b) => b.paid)),
    unpaid_break_minutes: sum(list.filter((b) => !b.paid)),
    on_break: !card.end_at && list.some((b) => b.running),
    break_flag: flag,
    breaks_known: true,
  };
}

export const FLAG_TEXT = { none: 'No break', short: 'Short break' };
