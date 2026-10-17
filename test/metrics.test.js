import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardsWithin, hourWindow, hoursWorkedBy } from '../src/metrics.js';
import { zonedMidnightUTC } from '../src/util.js';

test('time of day: ?hours= read safely, shifts and clock-ins cut to the hours', () => {
  assert.deepEqual(hourWindow({ hours: '7-11' }), { from: 7, to: 11, until: null });
  assert.deepEqual(hourWindow({ hours: '7-11', until: '9' }), { from: 7, to: 11, until: 9 });
  for (const hours of [undefined, 'all', '11-7', '0-24', '5-25', '7']) assert.equal(hourWindow({ hours }), null, hours);
  // A 6am–2pm shift with a 48-minute break (10%): 7am–11am is 4 hours, less 10%.
  assert.equal(Math.round(hoursWorkedBy({ start_time: '06:00', end_time: '14:00', break_minutes: 48 }, 11 * 60, 7 * 60) * 100) / 100, 3.6);
  // A clock-in 6am–2pm (8 hours, £80): 7am–11am is half of it.
  const midnight = Date.parse(zonedMidnightUTC('2026-10-14'));
  const [c] = cardsWithin([{ date: '2026-10-14', start: midnight + 6 * 3600000, end: midnight + 14 * 3600000, span: 8, hours: 8, cost: 80 }], { from: 7, to: 11, until: null }, '2026-10-14');
  assert.deepEqual([c.hours, c.cost], [4, 40]);
});
