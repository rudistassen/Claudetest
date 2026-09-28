// A pretend Square account for the demo: the same locations as the demo sites plus one extra, with
// deterministic orders (same day + site always gives the same sales) and clock-ins that follow the demo rota,
// answered in Square's API format.
import { zonedMidnightUTC } from '../src/util.js';

export const SQUARE_LOCATIONS = [
  ['SQ_HARBOUR', 'Harbour'], ['SQ_HIGH', 'High Street'], ['SQ_MARKET', 'Market Square'], ['SQ_OLDTOWN', 'Old Town'],
  ['SQ_RIVER', 'Riverside'], ['SQ_STATION', 'Station Road'], ['SQ_UNI', 'University Quarter'], ['SQ_POPUP', 'Summer Pop-up Kiosk'],
].map(([id, name], i) => ({
  id, name, status: 'ACTIVE', timezone: 'Europe/London', currency: 'GBP',
  address: { address_line_1: `${10 + i} ${name}`, locality: 'Brightwell', postal_code: `BW${i + 1} 4QA` },
}));

// [name, price in pence, standard-rated for VAT]
const MENU = [
  ['Flat white', 360, true], ['Latte', 370, true], ['Cappuccino', 360, true], ['Americano', 300, true], ['Oat latte', 410, true],
  ['Hot chocolate', 380, true], ['Croissant', 290, false], ['Pain au chocolat', 310, false], ['Bacon roll', 550, true],
  ['Avocado sourdough', 895, true], ['Ham & cheese toastie', 675, true], ['Brownie', 325, false], ['Orange juice', 280, true],
  ['Egg & cress sandwich', 495, false],
];
const WEIGHTS = [16, 14, 10, 8, 7, 4, 9, 5, 5, 3, 4, 6, 3, 4];

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const hash = (str) => [...str].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);

function pick(r) {
  let x = r() * WEIGHTS.reduce((a, b) => a + b, 0);
  for (let i = 0; i < MENU.length; i++) if ((x -= WEIGHTS[i]) < 0) return MENU[i];
  return MENU[0];
}

const cache = new Map();

function ordersFor(locIndex, isoDate) {
  const key = `${locIndex}|${isoDate}`;
  if (!cache.has(key)) cache.set(key, generate(locIndex, isoDate));
  return cache.get(key);
}

function generate(locIndex, isoDate) {
  const r = rng(hash(`${locIndex}|${isoDate}`));
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const busy = dow === 0 || dow === 6 ? 1.25 : 1;
  const count = Math.round((70 + r() * 50 + locIndex * 8) * busy);
  const out = [];
  for (let k = 0; k < count; k++) {
    // Opening hours roughly 07:00–17:00 UK time; stored as UTC like Square does.
    const minute = 7 * 60 + Math.floor(r() * 600);
    const local = new Date(`${isoDate}T00:00:00Z`);
    local.setUTCMinutes(minute - 60); // Europe/London is UTC+1 for most of the demo period
    const lines = Array.from({ length: 1 + Math.floor(r() * 2.4) }, () => {
      const [name, price, vat] = pick(r);
      const qty = r() < 0.15 ? 2 : 1;
      const total = price * qty;
      return {
        uid: `${k}-${name}`, name, quantity: String(qty), variation_name: 'Regular',
        catalog_object_id: `CAT_${name.replace(/\W/g, '').toUpperCase()}`,
        total_money: { amount: total, currency: 'GBP' },
        total_tax_money: { amount: vat ? Math.round(total / 6) : 0, currency: 'GBP' },
        total_discount_money: { amount: 0, currency: 'GBP' },
      };
    });
    out.push({
      id: `${SQUARE_LOCATIONS[locIndex].id}-${isoDate}-${k}`, location_id: SQUARE_LOCATIONS[locIndex].id, state: 'COMPLETED',
      closed_at: local.toISOString(), line_items: lines, total_tip_money: { amount: r() < 0.08 ? 100 : 0, currency: 'GBP' },
    });
  }
  return out;
}

// --- Team members and clock-ins, generated from the demo rota ---

let team = [];
let rotaShifts = [];

/** users: [{ id, name, email, role, position, hourly_rate, square_location_id }]; shifts: [{ id, user_id, square_location_id, date, start_time, end_time, break_minutes }] */
export function setFakeRota(users, shifts) {
  team = users;
  rotaShifts = shifts;
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const at = (date, minutes) => new Date(Date.parse(zonedMidnightUTC(date)) + minutes * 60000).toISOString();

// Mostly on time; now and then late, and very occasionally a no-show. Same shift always gives the same timecard.
function timecardFor(shift, now) {
  const r = rng(hash(`tc|${shift.id}|${shift.date}`));
  const start = toMin(shift.start_time);
  let end = toMin(shift.end_time);
  if (end <= start) end += 24 * 60;
  const inAt = start + (r() < 0.1 ? 6 + Math.floor(r() * 20) : -8 + Math.floor(r() * 12));
  const outAt = end + (r() < 0.25 ? 10 + Math.floor(r() * 30) : -10 + Math.floor(r() * 16));
  const noShow = r() < 0.03;
  const startAt = at(shift.date, inAt);
  if (noShow || startAt > now) return null;
  const endAt = at(shift.date, outAt);
  const breakStart = at(shift.date, start + Math.floor((end - start) / 2));
  const breakEnd = at(shift.date, start + Math.floor((end - start) / 2) + (shift.break_minutes || 0));
  const user = team.find((u) => u.id === shift.user_id);
  return {
    id: `TC_${shift.id}_${shift.date}`, location_id: shift.square_location_id, team_member_id: `TM_${shift.user_id}`,
    start_at: startAt, end_at: endAt <= now ? endAt : undefined, status: endAt <= now ? 'CLOSED' : 'OPEN',
    wage: { title: 'Team member', hourly_rate: { amount: Math.round((user?.hourly_rate ?? 0) * 100), currency: 'GBP' } },
    breaks: shift.break_minutes && breakStart <= now ? [{ start_at: breakStart, ...(breakEnd <= now ? { end_at: breakEnd } : {}), is_paid: false }] : [],
  };
}

function page(items, q, key, size) {
  const offset = Number(q.cursor ?? 0);
  return { [key]: items.slice(offset, offset + size), ...(offset + size < items.length ? { cursor: String(offset + size) } : {}) };
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export async function fakeSquareFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/v2/locations') return json(200, { locations: SQUARE_LOCATIONS });
  if (path === '/v2/team-members/search') {
    const members = team.map((u) => {
      const [given, ...rest] = u.name.split(' ');
      return {
        id: `TM_${u.id}`, given_name: given, family_name: rest.join(' '), email_address: u.email, status: 'ACTIVE', is_owner: u.role === 'admin',
        assigned_locations: u.square_location_id
          ? { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [u.square_location_id] }
          : { assignment_type: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' },
        wage_setting: { job_assignments: [{ job_title: u.position || 'Team member', pay_type: 'HOURLY', hourly_rate: { amount: Math.round(u.hourly_rate * 100), currency: 'GBP' } }] },
      };
    });
    return json(200, page(members, JSON.parse(init.body), 'team_members', 200));
  }
  if (path === '/v2/labor/shifts/search' || path === '/v2/labor/timecards/search') {
    const q = JSON.parse(init.body);
    const { start_at: start, end_at: end } = q.query.filter.start;
    const now = new Date().toISOString();
    const cards = rotaShifts
      .filter((s) => q.query.filter.location_ids.includes(s.square_location_id))
      .map((s) => timecardFor(s, now))
      .filter((t) => t && t.start_at >= start && t.start_at < end)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    return json(200, page(cards, q, path.endsWith('timecards/search') ? 'timecards' : 'shifts', 200));
  }
  if (path !== '/v2/orders/search') return json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Not found' }] });
  const q = JSON.parse(init.body);
  const { start_at: start, end_at: end } = q.query.filter.date_time_filter.closed_at;
  const now = new Date().toISOString();
  const all = [];
  for (let d = start.slice(0, 10); d <= end.slice(0, 10); d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    SQUARE_LOCATIONS.forEach((l, i) => {
      if (!q.location_ids.includes(l.id)) return;
      for (const o of ordersFor(i, d)) if (o.closed_at >= start && o.closed_at < end && o.closed_at <= now) all.push(o);
    });
  }
  const offset = Number(q.cursor ?? 0);
  const limit = q.limit ?? 500;
  return json(200, { orders: all.slice(offset, offset + limit), ...(offset + limit < all.length ? { cursor: String(offset + limit) } : {}) });
}
