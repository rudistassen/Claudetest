// In-browser build of Brewly: the real server routes run against SQLite (sql.js) inside the page,
// and window.fetch('/api/...') is answered locally instead of by a server.
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { loadUser, registerAuthRoutes, requireAuth } from '../src/auth.js';
import { openDb, publishAllShifts } from '../src/db.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import { registerOrderingRoutes } from '../src/routes/ordering.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { registerRotaRoutes } from '../src/routes/rota.js';
import { registerSafetyRoutes } from '../src/routes/safety.js';
import { registerSalesRoutes } from '../src/routes/sales.js';
import { registerStockRoutes } from '../src/routes/stock.js';
import { registerLeaveRoutes } from '../src/routes/leave.js';
import { registerTradingRoutes } from '../src/routes/trading.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { SquareClient, syncSales } from '../src/square.js';
import { memoryMailer } from '../src/email.js';
import { registerReportRoutes } from '../src/reports.js';
import { demoInvoiceReader } from '../src/invoice-demo.js';
import { registerInvoiceRoutes } from '../src/routes/invoices.js';
import { registerNewsRoutes } from '../src/routes/news.js';
import { registerDocumentRoutes } from '../src/routes/documents.js';
import { registerBreakRoutes } from '../src/routes/breaks.js';
import { registerInvoiceInboxRoutes, setSetting } from '../src/invoice-inbox.js';
import { memoryMailbox } from '../src/mailbox.js';
import { HttpError, addDays, today } from '../src/util.js';
import { seedActivity } from './activity.js';
import { SQUARE_LOCATIONS, fakeSquareFetch, setFakeRota } from './fake-square.js';

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
  publishAllShifts(db);

  const config = { token: 'demo', environment: 'demo account', baseUrl: 'https://square.demo', version: '2025-01-23', syncMinutes: 30 };
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
  registerAuthRoutes(api, db);
  api.use(requireAuth);
  registerAdminRoutes(api, db);
  registerRotaRoutes(api, db);
  registerOrderingRoutes(api, db);
  registerStockRoutes(api, db);
  registerSafetyRoutes(api, db);
  registerSalesRoutes(api, db, square);
  registerRecipeRoutes(api, db);
  registerTradingRoutes(api, db, square);
  registerLeaveRoutes(api, db);
  registerReportRoutes(api, db, demoMailer, { demo: true });
  const invoiceReader = demoInvoiceReader(db);
  registerInvoiceRoutes(api, db, invoiceReader);
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
  registerDocumentRoutes(api, db);
  registerBreakRoutes(api, db);
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
