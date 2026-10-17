import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attendance } from '../src/attendance.js';
import { openDb, publishShifts } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { addDays, today, zonedMidnightUTC } from '../src/util.js';

const db = openDb(':memory:');
seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
seedDemo(db);
const day = addDays(today(), 40); // a day with nothing else on the rota
const site = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
const [a, b, c, d] = db.prepare(`SELECT id FROM users WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 4`).all(site).map((u) => u.id);
const other = db.prepare(`SELECT id FROM users WHERE location_id != ? AND active = 1 LIMIT 1`).get(site).id;
const at = (h, m = 0) => Date.parse(zonedMidnightUTC(day)) + (h * 60 + m) * 60000;
const shift = db.prepare('INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, 0)');
shift.run(site, a, day, '09:00', '17:00');
shift.run(site, b, day, '09:00', '17:00');
shift.run(site, c, day, '10:00', '14:00');
shift.run(site, d, day, '18:00', '22:00');
publishShifts(db, [site], day, day);
const card = (id, user, start, end) => ({ id, location_id: site, user_id: user, start, end: end ?? at(15), end_at: end ? 'x' : null });

test('late in, and clocked out more than 5 minutes after the shift', () => {
  const now = at(18);
  const { byCard } = attendance(db, site, day, [card('1', a, at(9, 12), at(17, 4)), card('2', b, at(8, 55), at(17, 12))], now);
  assert.deepEqual(byCard.get('1'), { rota: '09:00–17:00', late_minutes: 12, over_minutes: 0, not_on_rota: false }, '4 minutes over is within the grace');
  assert.deepEqual(byCard.get('2'), { rota: '09:00–17:00', late_minutes: 0, over_minutes: 12, not_on_rota: false }, 'early in is fine');
});

test('still clocked in past the end of the shift, and clocking in without a shift', () => {
  const now = at(17, 30);
  const { byCard } = attendance(db, site, day, [{ ...card('3', a, at(9), null), end: now }, card('4', other, at(12), at(15))], now);
  assert.equal(byCard.get('3').over_minutes, 30);
  assert.equal(byCard.get('4').not_on_rota, true);
  const unknown = attendance(db, site, day, [card('5', null, at(12), at(15))], now).byCard.get('5');
  assert.equal(unknown.not_on_rota, false, 'a Square team member not linked to anyone isn’t called off-rota');
});

test('people whose shift has started but who haven’t clocked in', () => {
  const cards = [card('1', a, at(9), at(17))];
  const mid = attendance(db, site, day, cards, at(10, 25)).missing;
  assert.deepEqual(mid.map((m) => [m.rota, m.late_minutes, m.shift_over]), [['09:00–17:00', 85, false], ['10:00–14:00', 25, false]]);
  const evening = attendance(db, site, day, cards, at(23)).missing;
  assert.deepEqual(evening.map((m) => [m.rota, m.shift_over]), [['09:00–17:00', true], ['10:00–14:00', true], ['18:00–22:00', true]], 'by the end of the day: didn’t clock in');
});
