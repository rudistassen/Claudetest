import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { openDb, publishShifts } from '../src/db.js';
import { siteSummaries } from '../src/dashboard.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { addDays, today, zonedMidnightUTC } from '../src/util.js';

test('who’s in today: everyone on the rota at each site with where they are, then anyone clocked in without a shift', () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const day = addDays(today(), 41); // nothing else on the rota
  const [site, site2] = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 2').all().map((l) => l.id);
  const [a, b, c, d] = db.prepare('SELECT id FROM users WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 4').all(site).map((u) => u.id);
  const [e, extra] = db.prepare('SELECT id FROM users WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 2').all(site2).map((u) => u.id);
  const at = (h, m = 0) => new Date(Date.parse(zonedMidnightUTC(day)) + (h * 60 + m) * 60000).toISOString();
  const shift = db.prepare('INSERT INTO shifts (location_id, user_id, date, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, 0)');
  shift.run(site, a, day, '09:00', '17:00');
  shift.run(site, b, day, '09:00', '17:00');
  shift.run(site, c, day, '10:00', '14:00');
  shift.run(site, d, day, '18:00', '22:00');
  shift.run(site, e, day, '06:00', '08:00'); // covering from the other site
  publishShifts(db, [site], day, day);
  const card = db.prepare(`INSERT INTO timecards (id, location_id, team_member_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status, breaks_synced)
    VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 12, ?, 1)`);
  card.run('A', site, a, day, at(9, 7), null, 'OPEN');
  db.prepare('INSERT INTO timecard_breaks (timecard_id, start_at, end_at, is_paid, name) VALUES (?, ?, NULL, 0, ?)').run('A', at(11, 50), 'Lunch');
  card.run('B', site2, b, day, at(9), null, 'OPEN');
  card.run('X', site, extra, day, at(8), at(11), 'CLOSED');

  mock.timers.enable({ apis: ['Date'], now: Date.parse(at(12)) });
  try {
    const locations = db.prepare('SELECT * FROM locations WHERE id IN (?, ?) ORDER BY id').all(site, site2);
    const here = siteSummaries(db, { locations, seeClockIns: true, date: day }).locations.find((l) => l.id === site);
    assert.deepEqual(here.roster.map((p) => [p.rota, p.status]), [
      ['06:00–08:00', 'missed'],
      ['09:00–17:00', 'on_break'],
      ['09:00–17:00', 'elsewhere'],
      ['10:00–14:00', 'late'],
      ['18:00–22:00', 'due'],
      [null, 'extra'],
    ]);
    const byStatus = Object.fromEntries(here.roster.map((p) => [p.status, p]));
    assert.equal(byStatus.on_break.late_minutes, 7);
    assert.equal(byStatus.on_break.clock, '09:07–now');
    assert.equal(byStatus.late.late_minutes, 120);
    assert.match(byStatus.elsewhere.where, /\S/);
    assert.equal(byStatus.extra.clock, '08:00–11:00');

    // b is rota'd here but clocked in at the other site: that site lists b as in, covering from here.
    const there = siteSummaries(db, { locations, seeClockIns: true, date: day }).locations.find((l) => l.id === site2);
    const cover = there.roster.find((p) => p.rota_site);
    assert.deepEqual([cover.status, cover.rota, cover.rota_site, cover.clock], ['in', '09:00–17:00', locations[0].name, '09:00–now']);
  } finally {
    mock.timers.reset();
  }
});
