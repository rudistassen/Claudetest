import { tx } from './db.js';
import { BUSINESS_TZ, HttpError, addDays, localDate, localHour, round2, zonedMidnightUTC } from './util.js';

const BASE_URLS = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

// Square Orders API allows at most 10 location IDs per search.
const LOCATIONS_PER_SEARCH = 10;

// Square renamed Labor "shifts" to "timecards" in API version 2025-05-21; older versions use the shifts endpoint.
const TIMECARDS_VERSION = '2025-05-21';

export function squareConfig(env = process.env) {
  if (!env.SQUARE_ACCESS_TOKEN) return null;
  const environment = env.SQUARE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  return {
    token: env.SQUARE_ACCESS_TOKEN,
    environment,
    baseUrl: env.SQUARE_BASE_URL || BASE_URLS[environment],
    version: env.SQUARE_API_VERSION || '2025-01-23',
    syncMinutes: Number(env.SQUARE_SYNC_MINUTES) || 30,
  };
}

export class SquareClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(method, path, body, attempt = 0) {
    let res;
    try {
      res = await this.fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Square-Version': this.config.version,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new HttpError(502, `Could not reach Square: ${err.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.request(method, path, body, attempt + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.errors?.map((e) => e.detail || e.code).join('; ') || `HTTP ${res.status}`;
      const hint = res.status === 401 ? ' – check SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT' : '';
      throw new HttpError(502, `Square error: ${detail}${hint}`);
    }
    return data;
  }

  async listLocations() {
    return (await this.request('GET', '/v2/locations')).locations ?? [];
  }

  // Yields every COMPLETED order closed in [startAt, endAt) for the given Square locations.
  async *searchOrders({ locationIds, startAt, endAt }) {
    for (let i = 0; i < locationIds.length; i += LOCATIONS_PER_SEARCH) {
      let cursor;
      do {
        const page = await this.request('POST', '/v2/orders/search', {
          location_ids: locationIds.slice(i, i + LOCATIONS_PER_SEARCH),
          query: {
            filter: {
              state_filter: { states: ['COMPLETED'] },
              date_time_filter: { closed_at: { start_at: startAt, end_at: endAt } },
            },
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
          },
          limit: 500,
          cursor,
        });
        for (const order of page.orders ?? []) yield order;
        cursor = page.cursor;
      } while (cursor);
    }
  }

  // Yields every team member (active or not), so past clock-ins can be named.
  async *searchTeamMembers() {
    let cursor;
    do {
      const page = await this.request('POST', '/v2/team-members/search', { limit: 200, cursor });
      for (const m of page.team_members ?? []) yield m;
      cursor = page.cursor;
    } while (cursor);
  }

  // Yields each team member's pay for each job (older accounts without wage settings on the team member).
  async *listTeamMemberWages() {
    let cursor;
    do {
      const page = await this.request('GET', `/v2/labor/team-member-wages?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const w of page.team_member_wages ?? []) yield w;
      cursor = page.cursor;
    } while (cursor);
  }

  // Yields every clock-in (timecard) that started in [startAt, endAt) at the given Square locations.
  async *searchTimecards({ locationIds, startAt, endAt }) {
    const [path, key] = this.config.version >= TIMECARDS_VERSION
      ? ['/v2/labor/timecards/search', 'timecards']
      : ['/v2/labor/shifts/search', 'shifts'];
    let cursor;
    do {
      const page = await this.request('POST', path, {
        query: {
          filter: { location_ids: locationIds, start: { start_at: startAt, end_at: endAt } },
          sort: { field: 'START_AT', order: 'ASC' },
        },
        limit: 200,
        cursor,
      });
      for (const t of page[key] ?? []) yield t;
      cursor = page.cursor;
    } while (cursor);
  }
}

const money = (m) => (m?.amount ?? 0) / 100;

/**
 * Summarises one Square order into per-day and per-item totals.
 * Net sales = line totals after discounts, less VAT (UK prices are VAT-inclusive, so tax is inside total_money).
 * Itemised returns in the same order are subtracted.
 */
export function summariseOrder(order, tz = BUSINESS_TZ) {
  const lines = [];
  const add = (li, sign) => {
    const gross = money(li.total_money);
    const tax = money(li.total_tax_money);
    lines.push({
      key: li.catalog_object_id || `adhoc:${li.name ?? 'Custom amount'}|${li.variation_name ?? ''}`,
      catalog_object_id: li.catalog_object_id ?? null,
      name: li.name || 'Custom amount',
      variation_name: li.variation_name ?? null,
      quantity: sign * (Number(li.quantity) || 0),
      gross: sign * gross,
      tax: sign * tax,
      net: sign * (gross - tax),
      discount: sign * money(li.total_discount_money),
    });
  };
  for (const li of order.line_items ?? []) add(li, 1);
  for (const ret of order.returns ?? []) for (const li of ret.return_line_items ?? []) add(li, -1);
  return {
    date: localDate(order.closed_at, tz),
    hour: localHour(order.closed_at, tz),
    lines,
    tips: money(order.total_tip_money),
    isSale: (order.line_items ?? []).length > 0,
  };
}

/**
 * Summarises one Square timecard (clock-in). Unpaid breaks are subtracted; a break still running counts up to
 * `now`. The hourly rate is Square's wage for the job, when it has one.
 */
export function summariseTimecard(tc, tz = BUSINESS_TZ, now = Date.now()) {
  const end = tc.end_at ? Date.parse(tc.end_at) : now;
  let unpaid = 0;
  for (const b of tc.breaks ?? []) {
    if (b.is_paid || !b.start_at) continue;
    const bEnd = b.end_at ? Date.parse(b.end_at) : end;
    unpaid += Math.max(0, bEnd - Date.parse(b.start_at)) / 60000;
  }
  const rate = tc.wage?.hourly_rate?.amount;
  return {
    id: tc.id,
    square_location_id: tc.location_id,
    team_member_id: tc.team_member_id ?? tc.employee_id ?? null,
    date: localDate(tc.start_at, tz),
    start_at: new Date(tc.start_at).toISOString(),
    end_at: tc.end_at ? new Date(tc.end_at).toISOString() : null,
    unpaid_break_minutes: round2(unpaid),
    hourly_rate: rate === undefined || rate === null ? null : rate / 100,
    status: tc.status ?? (tc.end_at ? 'CLOSED' : 'OPEN'),
  };
}

const memberName = (m) => [m.given_name, m.family_name].filter(Boolean).join(' ') || m.email_address || m.id;

// Saves Square team members, matching each to an app user by email, then by name.
function saveTeamMembers(db, members) {
  const byEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE');
  const byName = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE');
  const upsert = db.prepare(`INSERT INTO square_team_members (id, name, email, user_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, user_id = COALESCE(excluded.user_id, square_team_members.user_id)`);
  for (const m of members) {
    const name = memberName(m);
    const userId = (m.email_address && byEmail.get(m.email_address)?.id) ?? byName.get(name)?.id ?? null;
    upsert.run(m.id, name, m.email_address ?? null, userId);
  }
}

// Fetches team members and clock-ins. Returns null (with the reason) if the token can't read Labor/Team data,
// so sales still sync for accounts that haven't granted those permissions.
async function fetchLabour(client, { locationIds, startAt, endAt, tz }) {
  try {
    const members = [];
    for await (const m of client.searchTeamMembers()) members.push(m);
    const timecards = [];
    for await (const t of client.searchTimecards({ locationIds, startAt, endAt })) timecards.push(summariseTimecard(t, tz));
    return { members, timecards };
  } catch (err) {
    return { error: err.message };
  }
}

let running = null;

/**
 * Pulls completed Square orders and clock-ins (timecards) for [from, to] and replaces the stored sales and
 * clock-ins for mapped sites in that range. If the token can't read Labor data, sales still sync and the
 * reason is logged.
 */
export function syncSales(db, client, { from, to, tz = BUSINESS_TZ, triggeredBy = 'system' }) {
  if (running) return Promise.reject(new HttpError(409, 'A Square sync is already running – try again in a moment'));
  running = doSync(db, client, { from, to, tz, triggeredBy }).finally(() => { running = null; });
  return running;
}

async function doSync(db, client, { from, to, tz, triggeredBy }) {
  const mapped = db.prepare('SELECT id, square_location_id FROM locations WHERE square_location_id IS NOT NULL').all();
  if (!mapped.length) throw new HttpError(400, 'Link at least one site to a Square location first');
  const bySquareId = new Map(mapped.map((l) => [l.square_location_id, l.id]));
  const log = db.prepare(`INSERT INTO square_sync_log (status, date_from, date_to, triggered_by) VALUES ('running', ?, ?, ?)`)
    .run(from, to, triggeredBy).lastInsertRowid;

  try {
    const daily = new Map();
    const hourly = new Map();
    const items = new Map();
    let orderCount = 0;
    const window = { locationIds: [...bySquareId.keys()], startAt: zonedMidnightUTC(from, tz), endAt: zonedMidnightUTC(addDays(to, 1), tz) };
    for await (const order of client.searchOrders(window)) {
      const locationId = bySquareId.get(order.location_id);
      if (!locationId || !order.closed_at) continue;
      const s = summariseOrder(order, tz);
      if (s.date < from || s.date > to) continue;
      orderCount++;
      const dk = `${locationId}|${s.date}`;
      const d = daily.get(dk) ?? { location_id: locationId, date: s.date, net: 0, gross: 0, tax: 0, discounts: 0, tips: 0, orders: 0 };
      d.tips += s.tips;
      if (s.isSale) d.orders += 1;
      const hk = `${dk}|${s.hour}`;
      const h = hourly.get(hk) ?? { location_id: locationId, date: s.date, hour: s.hour, net: 0, orders: 0 };
      if (s.isSale) h.orders += 1;
      for (const l of s.lines) h.net += l.net;
      hourly.set(hk, h);
      for (const l of s.lines) {
        d.net += l.net;
        d.gross += l.gross;
        d.tax += l.tax;
        d.discounts += l.discount;
        const ik = `${dk}|${l.key}`;
        const it = items.get(ik) ?? { location_id: locationId, date: s.date, key: l.key, catalog_object_id: l.catalog_object_id, name: l.name, variation_name: l.variation_name, quantity: 0, net: 0 };
        it.quantity += l.quantity;
        it.net += l.net;
        items.set(ik, it);
      }
      daily.set(dk, d);
    }

    const labour = await fetchLabour(client, { ...window, tz });
    const timecards = (labour.timecards ?? [])
      .map((t) => ({ ...t, location_id: bySquareId.get(t.square_location_id) }))
      .filter((t) => t.location_id && t.date >= from && t.date <= to);

    tx(db, () => {
      const ids = mapped.map((l) => l.id);
      const inList = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM sales_daily WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`).run(from, to, ...ids);
      db.prepare(`DELETE FROM sales_items WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`).run(from, to, ...ids);
      const insDay = db.prepare(`INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, tax, discounts, tips, orders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of daily.values()) insDay.run(d.location_id, d.date, round2(d.net), round2(d.gross), round2(d.tax), round2(d.discounts), round2(d.tips), d.orders);
      const insItem = db.prepare(`INSERT INTO sales_items (location_id, date, item_key, catalog_object_id, name, variation_name, quantity, net_sales) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of items.values()) insItem.run(it.location_id, it.date, it.key, it.catalog_object_id, it.name, it.variation_name, round2(it.quantity), round2(it.net));
      db.prepare(`DELETE FROM sales_hourly WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`).run(from, to, ...ids);
      const insHour = db.prepare(`INSERT INTO sales_hourly (location_id, date, hour, net_sales, orders) VALUES (?, ?, ?, ?, ?)`);
      for (const h of hourly.values()) insHour.run(h.location_id, h.date, h.hour, round2(h.net), h.orders);

      if (labour.error) return;
      saveTeamMembers(db, labour.members);
      db.prepare(`DELETE FROM timecards WHERE date BETWEEN ? AND ? AND location_id IN (${inList})`).run(from, to, ...ids);
      const insCard = db.prepare(`INSERT OR REPLACE INTO timecards (id, location_id, team_member_id, user_id, date, start_at, end_at, unpaid_break_minutes, hourly_rate, status)
        VALUES (?, ?, ?, (SELECT user_id FROM square_team_members WHERE id = ?), ?, ?, ?, ?, ?, ?)`);
      for (const t of timecards) {
        insCard.run(t.id, t.location_id, t.team_member_id, t.team_member_id, t.date, t.start_at, t.end_at, t.unpaid_break_minutes, t.hourly_rate, t.status);
      }
    });

    const message = labour.error ? `Sales synced, but clock-ins were not: ${labour.error}` : null;
    db.prepare(`UPDATE square_sync_log SET status = 'ok', finished_at = datetime('now'), orders = ?, timecards = ?, message = ? WHERE id = ?`)
      .run(orderCount, labour.error ? null : timecards.length, message, log);
    return { from, to, orders: orderCount, days: daily.size, timecards: labour.error ? null : timecards.length, warning: message };
  } catch (err) {
    db.prepare(`UPDATE square_sync_log SET status = 'error', finished_at = datetime('now'), message = ? WHERE id = ?`).run(err.message, log);
    throw err;
  }
}

/** Keeps today's and yesterday's sales and clock-ins fresh; backfills the last 28 days the first time. */
export function startAutoSync(db, client, config, { log = console } = {}) {
  const tick = async () => {
    const hasMapping = db.prepare('SELECT 1 FROM locations WHERE square_location_id IS NOT NULL').get();
    if (!hasMapping) return;
    const today = localDate(Date.now());
    const hasSales = db.prepare('SELECT 1 FROM sales_daily LIMIT 1').get();
    const from = addDays(today, hasSales ? -1 : -27);
    try {
      const r = await syncSales(db, client, { from, to: today, triggeredBy: 'auto' });
      log.log(`Square sync ${from}..${today}: ${r.orders} orders, ${r.timecards ?? 'no'} clock-ins`);
      if (r.warning) log.error(r.warning);
    } catch (err) {
      log.error(`Square sync failed: ${err.message}`);
    }
  };
  setTimeout(tick, 2000);
  return setInterval(tick, config.syncMinutes * 60 * 1000);
}
