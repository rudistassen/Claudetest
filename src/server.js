import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser, registerAuthRoutes, requireAuth } from './auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOrderingRoutes } from './routes/ordering.js';
import { registerRecipeRoutes } from './routes/recipes.js';
import { registerRotaRoutes } from './routes/rota.js';
import { registerSalesRoutes } from './routes/sales.js';
import { registerSafetyRoutes } from './routes/safety.js';
import { registerStockRoutes } from './routes/stock.js';
import { registerTradingRoutes } from './routes/trading.js';
import { HttpError } from './util.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function trustProxy(env) {
  if (env.TRUST_PROXY) return /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
  return env.RAILWAY_ENVIRONMENT || env.RENDER || env.FLY_APP_NAME ? 1 : 'loopback';
}

// square: { config, client } when a Square access token is configured, otherwise null.
export function createApp(db, { square = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting platform's proxy (Railway, Render, …) trust one hop, so HTTPS and visitors' addresses are seen.
  app.set('trust proxy', trustProxy(process.env));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.db = db;
    next();
  });
  app.use(loadUser(db));

  const api = express.Router();
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
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  app.use(express.static(publicDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

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
