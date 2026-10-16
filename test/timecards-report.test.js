import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb, publishAllShifts } from '../src/db.js';
import { DEFAULT_SETS } from '../src/permissions.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  publishAllShifts(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); return { status: r.status, data: await r.json().catch(() => null) }; };
}

test('timecards report: one row per clock-in, against the rota, searchable by name, pay only for people who can see it', async () => {
  assert.ok(DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions.includes('reports.timecards'));
  const staff = db.prepare(`SELECT id, location_id, name FROM users WHERE email = 'staff1@cafe.local'`).get();
  const shift = db.prepare('SELECT date, start_time FROM published_shifts WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(staff.id, today());
  assert.ok(shift, 'the demo has a shift for them');
  // Clocked in 10 minutes late (London time is UTC+0 or +1; use a timestamp with the offset written out).
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${shift.date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+0';
  const tz = `${offset.startsWith('-') ? '-' : '+'}${String(Math.abs(Number(offset))).padStart(2, '0')}:00`;
  const [h, m] = shift.start_time.split(':').map(Number);
  const startMin = h * 60 + m + 10;
  const startAt = new Date(`${shift.date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00${tz}`).toISOString();
  const endAt = new Date(Date.parse(startAt) + 4 * 3600000).toISOString();
  db.prepare(`INSERT INTO timecards (id, location_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status) VALUES ('TC-R1', ?, ?, ?, ?, ?, 30, 12, 'CLOSED')`)
    .run(staff.location_id, staff.id, shift.date, startAt, endAt);

  const manager = await login('manager1@cafe.local');
  const from = addDays(shift.date, -1);
  const r = (await manager(`/reports/timecards?from=${from}&to=${shift.date}&location_id=${staff.location_id}`)).data;
  const row = r.rows.find((x) => x.id === 'TC-R1');
  assert.ok(row);
  assert.equal(row.name, staff.name);
  assert.ok(row.rota.startsWith(shift.start_time));
  assert.equal(row.late_minutes, 10);
  assert.equal(row.hours, 3.5);
  assert.equal(row.cost, 42);
  assert.equal(r.see_pay, true);

  const searched = (await manager(`/reports/timecards?from=${from}&to=${shift.date}&location_id=${staff.location_id}&q=${encodeURIComponent(staff.name.slice(0, 3).toLowerCase())}`)).data;
  assert.ok(searched.rows.every((x) => x.name.toLowerCase().includes(staff.name.slice(0, 3).toLowerCase())));
  assert.equal((await manager(`/reports/timecards?from=${from}&to=${shift.date}&q=nobodycalledthis`)).data.rows.length, 0);

  // Without pay or sales: hours but not pay. Without the permission: no report.
  db.prepare('UPDATE users SET custom_permissions = ? WHERE email = ?').run(JSON.stringify(['reports.timecards']), 'staff1-2@cafe.local');
  const lead = await login('staff1-2@cafe.local');
  const limited = (await lead(`/reports/timecards?from=${from}&to=${shift.date}&location_id=${staff.location_id}`)).data;
  assert.equal(limited.see_pay, false);
  assert.equal(limited.rows.find((x) => x.id === 'TC-R1').cost, undefined);
  assert.equal((await (await login('staff1@cafe.local'))('/reports/timecards')).status, 403);
});
