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
  // Breaks: usually a 20–30 minute unpaid break mid-shift (the rota's, if it sets one), sometimes a paid
  // 10-minute tea break too, and now and then a long shift where the break was missed or cut short.
  const long = end - start > 6 * 60;
  const pick = r();
  const usual = shift.break_minutes || (long ? 20 + Math.floor(r() * 3) * 5 : 0);
  const mainMinutes = long && pick < 0.06 ? 0 : long && pick < 0.14 ? 12 : usual;
  const mid = start + Math.floor((end - start) / 2);
  const planned = [];
  if (mainMinutes) planned.push({ from: mid, to: mid + mainMinutes, paid: false, name: 'Lunch' });
  if (long && r() < 0.3) planned.push({ from: start + 120, to: start + 130, paid: true, name: 'Tea break' });
  const breaks = planned
    .map((b, i) => ({ id: `BR_${shift.id}_${shift.date}_${i}`, break_type_id: b.paid ? 'BT_TEA' : 'BT_LUNCH', start_at: at(shift.date, b.from), end_at: at(shift.date, b.to), is_paid: b.paid, name: b.name }))
    .filter((b) => b.start_at <= now)
    .map((b) => (b.end_at <= now ? b : { ...b, end_at: undefined }))
    .sort((x, y) => x.start_at.localeCompare(y.start_at));
  const user = team.find((u) => u.id === shift.user_id);
  return {
    id: `TC_${shift.id}_${shift.date}`, location_id: shift.square_location_id, team_member_id: `TM_${shift.user_id}`,
    start_at: startAt, end_at: endAt <= now ? endAt : undefined, status: endAt <= now ? 'CLOSED' : 'OPEN',
    wage: { title: 'Team member', hourly_rate: { amount: Math.round((user?.hourly_rate ?? 0) * 100), currency: 'GBP' } },
    breaks,
  };
}

// Clock-ins moved to another site from Brewly (timecard id → Square location id).
// …and ones whose breaks were changed (timecard id → changes).
const movedCards = new Map();
const withMove = (t) => (t && movedCards.has(t.id) ? { ...t, ...movedCards.get(t.id) } : t);
const BREAK_TYPES = [
  { id: 'BT_LUNCH', break_name: 'Lunch', expected_duration: 'PT30M', is_paid: false },
  { id: 'BT_SHORT', break_name: 'Short break', expected_duration: 'PT20M', is_paid: false },
  { id: 'BT_TEA', break_name: 'Tea break', expected_duration: 'PT10M', is_paid: true },
];
let breakIds = 0;
let paymentLinks = 0;
const linkOrders = new Map();

function page(items, q, key, size) {
  const offset = Number(q.cursor ?? 0);
  return { [key]: items.slice(offset, offset + size), ...(offset + size < items.length ? { cursor: String(offset + size) } : {}) };
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Team members added or changed from Brewly (Setup → Staff), on top of the ones made from the demo's staff.
const addedMembers = [];
const memberEdits = new Map();
const wageSettings = new Map();
const jobs = [{ id: 'JOB_BARISTA', title: 'Barista' }, { id: 'JOB_MANAGER', title: 'Manager' }];

function teamMembers() {
  const base = team.map((u) => {
      const [given, ...rest] = u.name.split(' ');
      return {
        id: `TM_${u.id}`, given_name: given, family_name: rest.join(' '), email_address: u.email, status: 'ACTIVE', is_owner: u.role === 'admin',
        assigned_locations: u.square_location_id
          ? { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [u.square_location_id] }
          : { assignment_type: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' },
        wage_setting: { job_assignments: [{ job_title: u.position || 'Team member', pay_type: 'HOURLY', hourly_rate: { amount: Math.round(u.hourly_rate * 100), currency: 'GBP' } }] },
      };
    });
  return [...base, ...addedMembers].map((m) => ({ ...m, ...memberEdits.get(m.id), ...(wageSettings.has(m.id) ? { wage_setting: wageSettings.get(m.id) } : {}) }));
}

function teamWrite(path, method, body) {
  if (path === '/v2/team-members/jobs') {
    if (method === 'GET') return json(200, { jobs });
    const job = { id: `JOB_${jobs.length + 1}`, title: body.job.title };
    jobs.push(job);
    return json(200, { job });
  }
  if (path === '/v2/team-members' && method === 'POST') {
    const m = { id: `TM_NEW_${addedMembers.length + 1}`, status: 'ACTIVE', is_owner: false, ...body.team_member };
    if (m.email_address && teamMembers().some((x) => x.email_address?.toLowerCase() === m.email_address.toLowerCase())) {
      return json(400, { errors: [{ code: 'INVALID_VALUE', detail: 'A team member with this email address already exists' }] });
    }
    addedMembers.push(m);
    return json(200, { team_member: m });
  }
  const [, id, wage] = path.match(/^\/v2\/team-members\/([^/]+)(\/wage-setting)?$/) ?? [];
  const member = id && teamMembers().find((m) => m.id === decodeURIComponent(id));
  if (!member) return null;
  if (wage) {
    if (method === 'PUT') wageSettings.set(member.id, { ...body.wage_setting, team_member_id: member.id });
    return json(200, { wage_setting: wageSettings.get(member.id) ?? { team_member_id: member.id, ...member.wage_setting } });
  }
  if (method === 'PUT') memberEdits.set(member.id, { ...memberEdits.get(member.id), ...body.team_member });
  return json(200, { team_member: teamMembers().find((m) => m.id === member.id) });
}

export async function fakeSquareFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/v2/locations') return json(200, { locations: SQUARE_LOCATIONS });
  if (path === '/v2/team-members/search') return json(200, page(teamMembers(), JSON.parse(init.body), 'team_members', 200));
  if (path.startsWith('/v2/team-members')) {
    const r = teamWrite(path, init.method ?? 'GET', init.body ? JSON.parse(init.body) : {});
    if (r) return r;
  }
  // Payment links: made instantly; each order counts as paid a minute after it's made (so "paid" can be tried).
  if (path === '/v2/online-checkout/payment-links' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    const n = ++paymentLinks;
    const link = { id: `PL_${n}`, order_id: `ORD_PL_${n}`, url: `https://square.link/u/demo${n}`, created_at: new Date().toISOString() };
    linkOrders.set(link.order_id, { created: Date.now(), amount: body.quick_pay.price_money.amount });
    return json(200, { payment_link: link });
  }
  if (path.startsWith('/v2/online-checkout/payment-links/') && init.method === 'DELETE') return json(200, { id: path.split('/').pop() });
  if (path.startsWith('/v2/orders/ORD_PL_')) {
    const o = linkOrders.get(path.split('/').pop());
    if (!o) return json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Order not found' }] });
    const paid = Date.now() - o.created > 60000;
    return json(200, { order: { id: path.split('/').pop(), state: paid ? 'COMPLETED' : 'OPEN', tenders: paid ? [{ id: 'T1' }] : [], net_amount_due_money: { amount: paid ? 0 : o.amount, currency: 'GBP' } } });
  }
  if (path === '/v2/labor/break-types') {
    const loc = new URL(url).searchParams.get('location_id');
    return json(200, { break_types: BREAK_TYPES.map((t) => ({ ...t, id: t.id, location_id: loc })) });
  }
  const one = path.match(/^\/v2\/labor\/(shifts|timecards)\/([^/]+)$/);
  if (one && one[2] !== 'search') {
    const now = new Date().toISOString();
    const card = rotaShifts.map((s) => withMove(timecardFor(s, now))).find((t) => t?.id === decodeURIComponent(one[2]));
    if (!card) return json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Timecard not found' }] });
    const key = one[1] === 'shifts' ? 'shift' : 'timecard';
    if ((init.method ?? 'GET') === 'PUT') {
      const sent = JSON.parse(init.body)[key];
      const breaks = (sent.breaks ?? []).map((b) => ({ ...b, id: b.id ?? `BR_NEW_${++breakIds}` }));
      movedCards.set(card.id, { location_id: sent.location_id, breaks });
      return json(200, { [key]: withMove(card) });
    }
    return json(200, { [key]: card });
  }
  if (path === '/v2/labor/shifts/search' || path === '/v2/labor/timecards/search') {
    const q = JSON.parse(init.body);
    const { start_at: start, end_at: end } = q.query.filter.start;
    const now = new Date().toISOString();
    const cards = rotaShifts
      .map((s) => withMove(timecardFor(s, now)))
      .filter((t) => t && q.query.filter.location_ids.includes(t.location_id))
      .filter((t) => t && t.start_at >= start && t.start_at < end)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    return json(200, page(cards, q, path.endsWith('timecards/search') ? 'timecards' : 'shifts', 200));
  }
  if (path !== '/v2/orders/search') return json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Not found' }] });
  const q = JSON.parse(init.body);
  // Open tabs: a couple per site, started in the last hour or so.
  if (q.query.filter.state_filter.states.includes('OPEN')) {
    const now = Date.now();
    const open = SQUARE_LOCATIONS.slice(0, 7).filter((l) => q.location_ids.includes(l.id)).flatMap((l, i) => [0, 1].slice(0, 1 + (i % 2)).map((k) => ({
      id: `OPEN-${l.id}-${k}`, location_id: l.id, state: 'OPEN', created_at: new Date(now - (10 + i * 7 + k * 20) * 60000).toISOString(),
      line_items: [{ name: 'Flat white', quantity: '2', total_money: { amount: 720, currency: 'GBP' }, total_tax_money: { amount: 120, currency: 'GBP' } },
        { name: 'Toastie', quantity: '1', total_money: { amount: 850 + i * 50, currency: 'GBP' }, total_tax_money: { amount: 142, currency: 'GBP' } }],
    })));
    return json(200, { orders: open });
  }
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
