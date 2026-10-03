import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakInfo } from '../src/breaks.js';
import { summariseTimecard } from '../src/square.js';

const H = 3600000;
const T0 = Date.parse('2026-09-29T07:00:00Z'); // 08:00 in London
const iso = (hours) => new Date(T0 + hours * H).toISOString();
const card = (hours, open = false) => ({ start: T0, end: T0 + hours * H, end_at: open ? null : iso(hours), breaks_synced: 1 });
const brk = (from, to, paid = false) => ({ start_at: iso(from), end_at: to === null ? null : iso(to), is_paid: paid ? 1 : 0 });

test('a shift over 6 hours needs one break of at least 20 minutes', () => {
  assert.equal(breakInfo(card(7), []).break_flag, 'none');
  assert.equal(breakInfo(card(7), [brk(3, 3.2)]).break_flag, 'short', '12 minutes');
  assert.equal(breakInfo(card(7), [brk(2, 2.15), brk(4, 4.15)]).break_flag, 'short', 'two 9-minute breaks aren’t one 20-minute break');
  assert.equal(breakInfo(card(7), [brk(3, 3.5)]).break_flag, null);
  assert.equal(breakInfo(card(6), []).break_flag, null, 'exactly 6 hours is fine');
  assert.equal(breakInfo(card(5), []).break_flag, null);
});

test('break times, paid and unpaid minutes, and someone on a break now', () => {
  const done = breakInfo(card(8), [brk(2, 2 + 10 / 60, true), brk(4, 4.5)]);
  assert.deepEqual(done.breaks.map((b) => [b.start, b.end, b.minutes, b.paid]), [['10:00', '10:10', 10, true], ['12:00', '12:30', 30, false]]);
  assert.equal(done.break_minutes, 40);
  assert.equal(done.paid_break_minutes, 10);
  assert.equal(done.unpaid_break_minutes, 30);
  assert.equal(done.on_break, false);

  // Clocked in 6½ hours ago, on a break that started 10 minutes ago: on break, and not yet called short.
  const now = T0 + 6.5 * H;
  const live = breakInfo(card(6.5, true), [brk(6.5 - 10 / 60, null)], now);
  assert.equal(live.on_break, true);
  assert.equal(live.breaks[0].end, null);
  assert.equal(live.breaks[0].minutes, 10);
  assert.equal(live.break_flag, null);
});

test('clock-ins synced before breaks were kept aren’t flagged', () => {
  const info = breakInfo({ ...card(8), breaks_synced: 0, unpaid_break_minutes: 30 }, []);
  assert.equal(info.breaks_known, false);
  assert.equal(info.break_flag, null);
  assert.equal(info.break_minutes, 30);
});

test('Square timecards keep their breaks', () => {
  const t = summariseTimecard({ id: 'x', location_id: 'L', start_at: iso(0), end_at: iso(8), breaks: [
    { start_at: iso(2), end_at: iso(2.25), is_paid: true, name: 'Tea' }, { start_at: iso(4), end_at: iso(4.5), is_paid: false },
  ] });
  assert.equal(t.unpaid_break_minutes, 30);
  assert.deepEqual(t.breaks.map((b) => [b.is_paid, b.name]), [[true, 'Tea'], [false, null]]);
});
