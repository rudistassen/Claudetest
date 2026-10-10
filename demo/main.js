// In-browser build of Atlas: the real server routes run against SQLite (sql.js) inside the page,
// and window.fetch('/api/...') is answered locally instead of by a server.
import { registerParLevelRoutes } from '../src/routes/par-levels.js';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { loadUser, registerAuthRoutes, requireAuth, blockWhileViewingAs } from '../src/auth.js';
import { openDb, publishAllShifts } from '../src/db.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import { registerOrderingRoutes } from '../src/routes/ordering.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { registerRotaRoutes } from '../src/routes/rota.js';
import { registerSafetyRoutes } from '../src/routes/safety.js';
import { registerSalesRoutes } from '../src/routes/sales.js';
import { registerStockRoutes } from '../src/routes/stock.js';
import { registerPrepOrderRoutes } from '../src/routes/prep-orders.js';
import { registerLeaveRoutes } from '../src/routes/leave.js';
import { registerTradingRoutes } from '../src/routes/trading.js';
import { registerOpenOrderRoutes } from '../src/routes/open-orders.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { SquareClient, syncSales } from '../src/square.js';
import { memoryMailer } from '../src/email.js';
import { registerReportRoutes } from '../src/reports.js';
import { demoInvoiceReader } from '../src/invoice-demo.js';
import { registerInvoiceRoutes } from '../src/routes/invoices.js';
import { registerXeroRoutes } from '../src/routes/xero.js';
import { registerPeopleRoutes } from '../src/routes/people.js';
import { registerCareersRoutes } from '../src/careers-inbox.js';
import { registerEventRoutes } from '../src/events.js';
import { registerNewsRoutes } from '../src/routes/news.js';
import { registerCourseRoutes } from '../src/routes/courses.js';
import { registerDocumentRoutes } from '../src/routes/documents.js';
import { registerBreakRoutes } from '../src/routes/breaks.js';
import { registerTimecardRoutes } from '../src/routes/timecards.js';
import { registerPaymentLinkRoutes } from '../src/routes/payment-links.js';
import { describe as weatherWords, registerWeatherRoutes } from '../src/weather.js';
import { registerInvoiceInboxRoutes, setSetting } from '../src/invoice-inbox.js';
import { memoryMailbox } from '../src/mailbox.js';
import { registerReviewRoutes, syncReviews } from '../src/google-reviews.js';
import { demoPlaces } from './google-reviews.js';
import { registerInviteRoutes, registerPasswordRoutes } from '../src/invites.js';
import { HttpError, addDays, today } from '../src/util.js';
import { seedActivity, seedCourse } from './activity.js';
import { SQUARE_LOCATIONS, fakeSquareFetch, setFakeRota } from './fake-square.js';
import { registerPushRoutes } from '../src/push.js';
import { activityLogger, registerActivityRoutes } from '../src/activity.js';
import { demoRotaReader } from '../src/rota-reader.js';
import { demoRotaAnalyst } from '../src/rota-analyst.js';

// --- A tiny Express-compatible router ---

class Router {
  constructor() {
    this.layers = [];
  }

  add(method, path, handlers) {
    if (typeof path === 'function') {
      handlers = [path, ...handlers];
      path = null;
    }
    let re = null;
    const keys = [];
    if (path) {
      const pattern = path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
      re = new RegExp(`^${pattern}$`);
    }
    this.layers.push({ method, re, keys, handlers });
  }

  use(path, ...handlers) { this.add(null, path, handlers); }
  get(path, ...handlers) { this.add('GET', path, handlers); }
  post(path, ...handlers) { this.add('POST', path, handlers); }
  put(path, ...handlers) { this.add('PUT', path, handlers); }
  delete(path, ...handlers) { this.add('DELETE', path, handlers); }

  async handle(req, res) {
    for (const layer of this.layers) {
      if (layer.method && layer.method !== req.method) continue;
      if (layer.re) {
        const m = req.path.match(layer.re);
        if (!m) continue;
        req.params = Object.fromEntries(layer.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      }
      for (const h of layer.handlers) {
        let called = false;
        let passed;
        await h(req, res, (err) => { called = true; passed = err; });
        if (passed) throw passed;
        if (!called) return;
      }
    }
  }
}

function errorResponse(err) {
  if (err instanceof HttpError) return [err.status, { error: err.message }];
  if (/UNIQUE constraint failed/.test(err.message)) return [409, { error: `That ${err.message.split('.').pop()} is already in use` }];
  console.error(err);
  return [500, { error: 'Something went wrong' }];
}

async function boot() {
  globalThis.__SQL = await initSqlJs();
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  seedActivity(db);
  seedCourse(db);
  publishAllShifts(db);

  const config = { token: 'demo', environment: 'demo account', baseUrl: 'https://square.demo', version: '2025-01-23', syncMinutes: 5 };
  const square = { config, client: new SquareClient(config, fakeSquareFetch) };
  const demoMailer = memoryMailer();
  for (const l of SQUARE_LOCATIONS.slice(0, 7)) {
    db.prepare('UPDATE locations SET square_location_id = ? WHERE name = ?').run(l.id, l.name);
  }
  setFakeRota(
    db.prepare('SELECT u.id, u.name, u.email, u.role, u.position, u.hourly_rate, l.square_location_id FROM users u LEFT JOIN locations l ON l.id = u.location_id').all(),
    db.prepare(`SELECT s.id, s.user_id, l.square_location_id, s.date, s.start_time, s.end_time, s.break_minutes
      FROM shifts s JOIN locations l ON l.id = s.location_id WHERE l.square_location_id IS NOT NULL`).all(),
  );
  await syncSales(db, square.client, { from: addDays(today(), -20), to: today(), triggeredBy: 'auto' });

  const api = new Router();
  const cookies = {};
  api.use((req, _res, next) => { req.db = db; next(); });
  api.use(loadUser(db));
  api.use(blockWhileViewingAs);
  registerAuthRoutes(api, db);
  registerPasswordRoutes(api, db, demoMailer);
  api.use(requireAuth);
  api.use(activityLogger(db));
  registerInviteRoutes(api, db, demoMailer, { demo: true, square });
  registerAdminRoutes(api, db, square);
  registerRotaRoutes(api, db, { rotaReader: demoRotaReader(), rotaAnalyst: demoRotaAnalyst() });
  registerOrderingRoutes(api, db);
  registerStockRoutes(api, db);
  registerPushRoutes(api, db);
  registerPrepOrderRoutes(api, db);
  registerParLevelRoutes(api, db);
  registerSafetyRoutes(api, db);
  registerSalesRoutes(api, db, square);
  registerRecipeRoutes(api, db, square);
  registerTradingRoutes(api, db, square);
  registerOpenOrderRoutes(api, db, square);
  registerLeaveRoutes(api, db);
  registerReportRoutes(api, db, demoMailer, { demo: true });
  const invoiceReader = demoInvoiceReader(db);
  registerInvoiceRoutes(api, db, invoiceReader);
  // Xero isn't connected in the demo: Setup → Xero shows how to set it up.
  registerXeroRoutes(api, db, null);
  // A pretend careers inbox with a few applications waiting, so People → Recruitment's "Check now" can be tried.
  const careersInbox = memoryMailbox([
    { id: 'cv-1', subject: 'Barista application', from: 'maya.patel@example.com', fromName: 'Maya Patel', to: ['careers@example.com'], receivedAt: new Date(Date.now() - 26 * 3600000).toISOString(),
      body: 'Hi there,\n\nI’d love to apply for the barista role. I’ve worked at a busy independent coffee shop for two years and I’m confident on the machine, latte art and the till.\n\nI’m free weekends and most weekdays. My CV is attached.\n\nThanks,\nMaya\n07700 900123',
      attachments: [{ name: 'Maya Patel CV.pdf', contentType: 'application/pdf', size: 52000, isInline: false, data: btoa('%PDF-1.4 demo CV %%EOF') }] },
    { id: 'cv-2', subject: 'Any jobs going?', from: 'tom.r@example.com', fromName: 'Tom Reed', to: ['careers@example.com'], receivedAt: new Date(Date.now() - 5 * 3600000).toISOString(),
      body: 'Hello, I’m a student looking for part-time work in the kitchen or front of house. I have food hygiene level 2. CV attached – thanks!\nTom',
      attachments: [{ name: 'Tom_Reed_CV.docx', contentType: 'application/octet-stream', size: 31000, isInline: false, data: btoa('demo docx') }] },
    { id: 'cv-3', subject: 'Automatic reply: Your application', from: 'someone@example.com', fromName: 'Someone', to: ['careers@example.com'], receivedAt: new Date(Date.now() - 3600000).toISOString(), body: 'I am out of the office.' },
  ], 'careers@brewandbarrel.example');
  registerPeopleRoutes(api, db, { careers: careersInbox });
  registerCareersRoutes(api, db, { mailbox: careersInbox });
  // A pretend events inbox with a few enquiries waiting, so Events → Enquiries' "Check now" can be tried.
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  // A stand-in for the enquiry reader: in the real app Claude reads each email; here a few patterns are picked out.
  const demoEnquiryReader = {
    async read({ emails, sites }) {
      const text = emails.map((e) => `${e.subject} ${e.body}`).join(' ');
      const last = emails.at(-1);
      const marketing = /unsubscribe|newsletter|webinar|talked about|special offer/i.test(text);
      const people = text.match(/(?:about|around|for)?\s*(\d{1,4})\s*(?:people|guests)/i);
      const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const d = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i);
      let date = null;
      if (d) {
        const now = new Date();
        let y = now.getFullYear();
        const m = months.indexOf(d[2].toLowerCase());
        if (new Date(y, m, Number(d[1])) < now) y++;
        date = `${y}-${String(m + 1).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`;
      }
      const t = text.match(/(\d{1,2})\s*pm/i);
      const type = /birthday/i.test(text) ? 'Birthday party' : /breakfast|meeting/i.test(text) ? 'Meeting' : /wedding/i.test(text) ? 'Wedding / reception' : null;
      const phone = text.match(/0\d{4}\s?\d{6}/);
      return {
        kind: marketing ? 'marketing' : 'enquiry', kind_reason: marketing ? 'A newsletter from a software company' : 'Asking about an event',
        needs_reply: !marketing && last.direction === 'in' && !/found somewhere|no longer need|thanks so much/i.test(last.body ?? ''), title: null, event_type: type, event_date: date, start_time: t ? `${Number(t[1]) + 12}:00` : null, end_time: null,
        guests: people ? Number(people[1]) : null, budget: null, contact_name: null, phone: phone ? phone[0] : null,
        site: sites.find((s) => text.toLowerCase().includes(s.toLowerCase())) ?? null,
      };
    },
  };
  registerEventRoutes(api, db, { reader: demoEnquiryReader, mailbox: memoryMailbox([
    { id: 'ev-1', conversationId: 'conv-1', subject: '40th birthday party – Harbour', from: 'sarah.jones@example.com', fromName: 'Sarah Jones', receivedAt: hoursAgo(30),
      body: 'Hi,\n\nI’m looking to book a space for my husband’s 40th birthday on Saturday 14th November, around 7pm until late. We’d be about 40 people.\n\nCould you send me some options for food and drinks packages?\n\nThanks,\nSarah\n07700 900456' },
    { id: 'ev-2', conversationId: 'conv-2', subject: 'Corporate breakfast meeting', from: 'events@acme.example', fromName: 'Priya at Acme', receivedAt: hoursAgo(6),
      body: 'Hello – do you host breakfast meetings for around 15 people? We’d need a screen. Looking at early December, weekday mornings.\n\nPriya' },
    { id: 'ev-4', conversationId: 'conv-4', subject: 'Your restaurant is being talked about on Reddit. Are you there?', from: 'hello@sevenrooms.example', fromName: 'SevenRooms', receivedAt: hoursAgo(20),
      body: 'Learn what Reddit communities are saying about restaurants like yours — and how to show up in a way that actually helps. Join our webinar.\n\nUnsubscribe' },
    { id: 'ev-5', conversationId: 'conv-5', subject: 'Xmas drinks enquiry', from: 'kate@example.com', fromName: 'Kate Cramer', receivedAt: hoursAgo(26),
      body: 'Hi, do you have space for 25 for Christmas drinks on 18th December?' },
    { id: 'ev-6', folder: 'sent', conversationId: 'conv-5', subject: 'Re: Xmas drinks enquiry', to: ['kate@example.com'], sentAt: hoursAgo(25),
      body: 'Hi Kate, yes – our back room would be perfect. Shall I hold it for you?\n\nFrom: Kate Cramer\nSent: yesterday\nHi, do you have space…' },
    { id: 'ev-7', conversationId: 'conv-5', subject: 'Re: Xmas drinks enquiry', from: 'kate@example.com', fromName: 'Kate Cramer', receivedAt: hoursAgo(4),
      body: 'Thanks so much, we’ve found somewhere else this time but will definitely bear you in mind.' },
    { id: 'ev-3', conversationId: 'conv-1', subject: 'Re: 40th birthday party – Harbour', from: 'sarah.jones@example.com', fromName: 'Sarah Jones', receivedAt: hoursAgo(2),
      body: 'Just to add – a couple of the guests are vegan, is that ok?\n\nSarah' },
  ], 'events@brewandbarrel.example') });
  // A pretend shared inbox with a few emails waiting, so "Check now" under Invoices can be tried.
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const fakePdf = btoa('%PDF-1.4 demo invoice %%EOF');
  setSetting(db, 'invoice_inbox_since', ago(120));
  registerInvoiceInboxRoutes(api, db, { reader: invoiceReader, mailbox: memoryMailbox([
    { id: 'demo-1', subject: 'Invoice INV-20931 – Harbour', from: 'accounts@hearthbakery.example', fromName: 'Hearth Bakery', to: ['invoices@example.com'], receivedAt: ago(95), preview: 'Please find attached our invoice.',
      attachments: [{ name: 'INV-20931.pdf', contentType: 'application/pdf', size: 48213, isInline: false, data: fakePdf }] },
    { id: 'demo-2', subject: 'Your weekly statement', from: 'billing@metro.example', fromName: 'Metro Wholesale', to: ['invoices@example.com'], receivedAt: ago(40), preview: 'Invoice for delivery to Old Town attached.',
      attachments: [{ name: 'metro-invoice.pdf', contentType: 'application/pdf', size: 90211, isInline: false, data: fakePdf },
        { name: 'logo.png', contentType: 'image/png', size: 4096, isInline: true, data: btoa('png') }] },
    { id: 'demo-3', subject: 'Re: delivery times', from: 'orders@originroasters.example', fromName: 'Origin Coffee Roasters', to: ['invoices@example.com'], receivedAt: ago(10), preview: 'Thanks – see our updated delivery times.',
      attachments: [{ name: 'signature.png', contentType: 'image/png', size: 3000, isInline: true, data: btoa('png') }] },
  ], 'invoices@brewandbarrel.example') });
  registerNewsRoutes(api, db);
  registerCourseRoutes(api, db);
  registerActivityRoutes(api, db);
  registerDocumentRoutes(api, db);
  registerBreakRoutes(api, db);
  registerTimecardRoutes(api, db, square);
  registerPaymentLinkRoutes(api, db, square, demoMailer);
  // A made-up London week, so the dashboard's forecast has something to show.
  registerWeatherRoutes(api, async () => [3, 61, 2, 0, 80, 1, 63].map((code, i) => ({
    date: addDays(today(), i), ...weatherWords(code), max: [16, 14, 15, 18, 13, 17, 12][i], min: [9, 8, 7, 10, 8, 9, 6][i], rain: [20, 80, 10, 0, 70, 5, 90][i],
  })));
  // Pretend Google Maps listings: every site but one is linked, with a rating from a month ago to compare against.
  const reviewSites = db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY id').all();
  const places = demoPlaces(reviewSites);
  reviewSites.slice(0, -1).forEach((s, i) => db.prepare('UPDATE locations SET google_place_id = ? WHERE id = ?').run(places.places[i].place_id, s.id));
  await syncReviews(db, places);
  reviewSites.slice(0, -1).forEach((s, i) => db.prepare('INSERT INTO google_ratings (location_id, date, rating, review_count) VALUES (?, ?, ?, ?)')
    .run(s.id, addDays(today(), -28), Math.round((places.places[i].rating - [0.1, 0, 0.2, -0.1, 0.1, 0, 0.1][i % 7]) * 10) / 10, places.places[i].count - 4 - i));
  registerReviewRoutes(api, db, places);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const req = {
      method: (init.method || 'GET').toUpperCase(),
      path: url.pathname.slice(4),
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(init.body) : {},
      headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') },
      params: {},
      secure: false,
      protocol: 'https',
      ip: 'demo',
      get: (h) => (String(h).toLowerCase() === 'host' ? 'brewly.demo' : undefined),
    };
    const res = {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '',
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = JSON.stringify(data); },
      send(body) { this.body = body instanceof Uint8Array ? body : String(body); },
      setHeader(k, v) { this.headers[k] = v; },
      cookie(name, value) { cookies[name] = value; },
      clearCookie(name) { delete cookies[name]; },
      end() {},
    };
    try {
      await api.handle(req, res);
    } catch (err) {
      const [status, data] = errorResponse(err);
      res.status(status).json(data);
    }
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  };

  // Downloads are blocked inside the page, so show exports (CSV) in a dialog instead.
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('a[href^="/api/"]:not([data-doc])'); // company documents download themselves
    if (!a) return;
    e.preventDefault();
    const text = await (await window.fetch(a.getAttribute('href'))).text();
    const { openModal, esc } = await import('../public/js/lib.js');
    openModal({ title: 'Export (CSV)', wide: true, body: `<p class="muted">In the installed app this downloads as a file. Copy it into Excel or Google Sheets:</p><textarea rows="14" readonly>${esc(text)}</textarea>` });
  }, true);

  await import('../public/js/app.js');
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app').innerHTML = `<div class="loading">The demo could not start: ${String(err.message)}</div>`;
});
