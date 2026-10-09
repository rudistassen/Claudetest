import { registerParLevelRoutes } from './routes/par-levels.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser, registerAuthRoutes, requireAuth, blockWhileViewingAs } from './auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOrderingRoutes } from './routes/ordering.js';
import { registerRecipeRoutes } from './routes/recipes.js';
import { registerRotaRoutes } from './routes/rota.js';
import { registerSalesRoutes } from './routes/sales.js';
import { registerSafetyRoutes } from './routes/safety.js';
import { registerStockRoutes } from './routes/stock.js';
import { registerPrepOrderRoutes } from './routes/prep-orders.js';
import { registerLeaveRoutes } from './routes/leave.js';
import { registerTradingRoutes } from './routes/trading.js';
import { registerOpenOrderRoutes } from './routes/open-orders.js';
import { registerReportRoutes } from './reports.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerXeroRoutes } from './routes/xero.js';
import { registerPeopleRoutes } from './routes/people.js';
import { Xero } from './xero.js';
import { registerNewsRoutes } from './routes/news.js';
import { registerCourseRoutes } from './routes/courses.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerBreakRoutes } from './routes/breaks.js';
import { registerTimecardRoutes } from './routes/timecards.js';
import { registerPaymentLinkRoutes } from './routes/payment-links.js';
import { londonWeather, registerWeatherRoutes } from './weather.js';
import { registerInvoiceInboxRoutes } from './invoice-inbox.js';
import { registerCareersRoutes } from './careers-inbox.js';
import { registerEventRoutes } from './events.js';
import { registerReviewRoutes } from './google-reviews.js';
import { registerInviteRoutes, registerPasswordRoutes } from './invites.js';
import { HttpError } from './util.js';
import { registerPushRoutes } from './push.js';
import { activityLogger, registerActivityRoutes } from './activity.js';

export const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function trustProxy(env) {
  if (env.TRUST_PROXY) return /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
  return env.RAILWAY_ENVIRONMENT || env.RENDER || env.FLY_APP_NAME ? 1 : 'loopback';
}

// square: { config, client } when a Square access token is configured, otherwise null.
// mailer: sends the emailed reports (see email.js), or null when email isn't set up.
// invoiceReader: reads uploaded supplier invoices (see invoice-reader.js), or null when it isn't set up.
// mailbox: the shared invoice inbox (see mailbox.js), or null when it isn't connected.
// careers: the shared careers inbox (see careers-inbox.js), or null when it isn't connected.
// events: the shared events inbox (see events.js), or null when it isn't connected.
// enquiryReader: reads event enquiry emails for their details (see enquiry-reader.js), or null.
// places: Google Maps, for each site's rating and reviews (see google-reviews.js), or null when it isn't set up.
// version: the app's version (see app-version.js), so open copies can tell when there's a newer one.
// xero: { config, fetch? } when Xero is set up (see xero.js), otherwise null.
export function createApp(db, { square = null, mailer = null, invoiceReader = null, mailbox = null, careers = null, events = null, enquiryReader = null, places = null, version = null, weather = londonWeather(), xero = null } = {}) {
  const xeroClient = xero ? new Xero(db, xero.config, xero.fetch) : null;
  const app = express();
  app.disable('x-powered-by');
  // Browser protections: only this site's own scripts run, pages can't be shown inside other sites (stops
  // click-jacking), files aren't second-guessed into another type, and HTTPS is remembered once used.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:", "media-src 'self' blob:", "frame-src 'self' blob: https://www.youtube-nocookie.com",
        "connect-src 'self'", "font-src 'self' data:", "object-src 'none'", "base-uri 'self'",
        "form-action 'self'", "frame-ancestors 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Behind a hosting platform's proxy (Railway, Render, …) trust one hop, so HTTPS and visitors' addresses are seen.
  app.set('trust proxy', trustProxy(process.env));
  // Invoice uploads carry the file itself (up to 10 MB, a third bigger once encoded); everything else is small.
  app.use('/api/invoices/scan', express.json({ limit: '15mb' }));
  // News photos and short videos (up to 25 MB, a third bigger once encoded).
  app.use('/api/news/media', express.json({ limit: '36mb' }));
  // Company documents (up to 20 MB, a third bigger once encoded).
  app.use('/api/documents', express.json({ limit: '28mb' }));
  // CVs added to a candidate (up to 10 MB, a third bigger once encoded).
  app.use(/^\/api\/candidates\/\d+\/files$/, express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.db = db;
    next();
  });
  app.use(loadUser(db));

  const api = express.Router();
  api.get('/version', (_req, res) => res.set('Cache-Control', 'no-store').json({ version }));
  api.use(blockWhileViewingAs);
  registerAuthRoutes(api, db);
  registerPasswordRoutes(api, db, mailer);
  api.use(requireAuth);
  api.use(activityLogger(db));
  registerInviteRoutes(api, db, mailer, { square });
  registerAdminRoutes(api, db, square);
  registerRotaRoutes(api, db);
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
  registerReportRoutes(api, db, mailer);
  registerInvoiceRoutes(api, db, invoiceReader, { xero: xeroClient });
  registerXeroRoutes(api, db, xeroClient);
  registerPeopleRoutes(api, db, { careers });
  registerCareersRoutes(api, db, { mailbox: careers });
  registerEventRoutes(api, db, { mailbox: events, reader: enquiryReader });
  registerNewsRoutes(api, db);
  registerCourseRoutes(api, db);
  registerActivityRoutes(api, db);
  registerDocumentRoutes(api, db);
  registerBreakRoutes(api, db);
  registerTimecardRoutes(api, db, square);
  registerPaymentLinkRoutes(api, db, square, mailer);
  registerWeatherRoutes(api, weather);
  registerInvoiceInboxRoutes(api, db, { mailbox, reader: invoiceReader });
  registerReviewRoutes(api, db, places);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // Browsers must check for a newer copy every time (a quick "not changed" when nothing is new), so an update
  // shows up straight away instead of an old saved copy being used.
  app.use(express.static(publicDir, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(publicDir, 'index.html')));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (/UNIQUE constraint failed/.test(err.message)) {
      const field = err.message.split('.').pop();
      return res.status(409).json({ error: `That ${field} is already in use` });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
