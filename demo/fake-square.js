// A pretend Square account for the demo: the same locations as the demo sites plus one extra, with
// deterministic orders (same day + site always gives the same sales) answered in Square's API format.

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

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export async function fakeSquareFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path === '/v2/locations') return json(200, { locations: SQUARE_LOCATIONS });
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
