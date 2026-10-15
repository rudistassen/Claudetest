import express from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const PLAYER_COOKIE = 'hunt_player';
const STAFF_COOKIE = 'hunt_staff';
const PLAYER_DAYS = 60;
const STAFF_HOURS = 12;
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateConfig(config) {
  const ids = new Set();
  const codes = new Set();
  for (const cp of config.checkpoints) {
    for (const key of ['id', 'code', 'name', 'clue', 'found']) {
      if (!cp[key] || typeof cp[key] !== 'string') throw new Error(`Checkpoint is missing "${key}": ${JSON.stringify(cp)}`);
    }
    if (ids.has(cp.id)) throw new Error(`Two checkpoints have the id "${cp.id}"`);
    if (codes.has(cp.code)) throw new Error(`Two checkpoints have the code "${cp.code}"`);
    if (cp.code.length < 6) throw new Error(`The code for "${cp.id}" is too short; use 8 or more letters and numbers`);
    ids.add(cp.id);
    codes.add(cp.code);
  }
  if (!Number.isInteger(config.required) || config.required < 1 || config.required > config.checkpoints.length) {
    throw new Error(`"required" must be between 1 and the number of checkpoints (${config.checkpoints.length})`);
  }
}

// Allows `max` hits per key in a sliding window.
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (now - v[v.length - 1] >= windowMs) hits.delete(k);
    }
    return recent.length <= max;
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest();
const passwordMatches = (given, expected) => Boolean(expected) && timingSafeEqual(sha256(given), sha256(expected));

function normaliseEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Please enter a valid email address');
  }
  return email;
}

function normaliseClaimCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return 'BOO-' + code.replace(/^BOO/, '');
}

// SQLite's datetime('now') is UTC without a zone: '2026-10-26 14:00:00'.
const utcIso = (s) => (s ? s.replace(' ', 'T') + 'Z' : null);

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets running formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// options: { staffPassword, adminPassword, now } (now is for tests)
export function createApp(db, config, { staffPassword, adminPassword, now = () => new Date() } = {}) {
  validateConfig(config);
  const byCode = new Map(config.checkpoints.map((c) => [c.code, c]));
  const checkpointIds = new Set(config.checkpoints.map((c) => c.id));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway puts one proxy in front of the app
  app.use(express.json({ limit: '10kb' }));

  const joinLimit = rateLimiter(100, 60 * 60 * 1000); // per IP; cafe Wi-Fi is shared
  const badScanLimit = rateLimiter(20, 60 * 60 * 1000); // per player
  const loginLimit = rateLimiter(10, 15 * 60 * 1000); // per IP

  // ----- Sessions -----------------------------------------------------------

  const findSession = db.prepare(`SELECT kind, player_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`);
  const insertSession = db.prepare(`INSERT INTO sessions (token, kind, player_id, expires_at) VALUES (?, ?, ?, datetime('now', ?))`);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  db.exec(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);

  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const player = cookies[PLAYER_COOKIE] && findSession.get(cookies[PLAYER_COOKIE]);
    req.playerId = player?.kind === 'player' ? player.player_id : null;
    const staff = cookies[STAFF_COOKIE] && findSession.get(cookies[STAFF_COOKIE]);
    req.staffRole = staff && staff.kind !== 'player' ? staff.kind : null;
    req.cookies = cookies;
    next();
  });

  function startSession(req, res, cookie, kind, playerId, seconds) {
    if (req.cookies[cookie]) deleteSession.run(req.cookies[cookie]);
    const token = randomBytes(32).toString('base64url');
    insertSession.run(token, kind, playerId, `+${seconds} seconds`);
    setCookie(req, res, cookie, token, seconds);
  }
  function endSession(req, res, cookie) {
    if (req.cookies[cookie]) deleteSession.run(req.cookies[cookie]);
    setCookie(req, res, cookie, '', 0);
  }

  const requirePlayer = (req, _res, next) =>
    next(req.playerId ? undefined : new HttpError(401, 'Please enter your email to start the hunt'));
  const requireStaff = (req, _res, next) =>
    next(req.staffRole ? undefined : new HttpError(401, 'Please sign in'));
  const requireAdmin = (req, _res, next) =>
    next(req.staffRole === 'admin' ? undefined : new HttpError(req.staffRole ? 403 : 401, 'Admin sign-in needed'));

  // ----- Hunt state ---------------------------------------------------------

  function huntStatus() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone || 'Europe/London' }).format(now());
    if (config.startDate && today < config.startDate) return 'early';
    if (config.endDate && today > config.endDate) return 'over';
    return 'open';
  }

  const playerById = db.prepare('SELECT id, email, marketing_consent FROM players WHERE id = ?');
  const scansFor = db.prepare('SELECT checkpoint_id FROM scans WHERE player_id = ?');
  const prizeFor = db.prepare('SELECT claim_code, won_at, claimed_at FROM prizes WHERE player_id = ?');

  const prizeJson = (p) => (p ? { code: p.claim_code, wonAt: utcIso(p.won_at), claimedAt: utcIso(p.claimed_at) } : null);
  function foundIds(playerId) {
    return new Set(scansFor.all(playerId).map((s) => s.checkpoint_id).filter((id) => checkpointIds.has(id)));
  }

  function huntPayload(playerId) {
    const found = playerId ? foundIds(playerId) : new Set();
    const player = playerId ? playerById.get(playerId) : null;
    return {
      name: config.name,
      business: config.business,
      intro: config.intro,
      required: config.required,
      prize: config.prize,
      claimInstructions: config.claimInstructions,
      privacyNote: config.privacyNote,
      marketingConsentLabel: config.marketingConsentLabel,
      startDate: config.startDate,
      endDate: config.endDate,
      status: huntStatus(),
      checkpoints: config.checkpoints.map((c, i) => ({
        number: i + 1,
        clue: c.clue,
        found: found.has(c.id),
        name: found.has(c.id) ? c.name : null,
      })),
      player: player
        ? { email: player.email, found: found.size, prize: prizeJson(prizeFor.get(playerId)) }
        : null,
    };
  }

  const insertPrize = db.prepare('INSERT INTO prizes (player_id, claim_code) VALUES (?, ?)');
  function awardPrize(playerId) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = 'BOO-' + Array.from({ length: 5 }, () => CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)]).join('');
      try {
        insertPrize.run(playerId, code);
        return;
      } catch (err) {
        if (!/UNIQUE constraint failed: prizes.claim_code/.test(err.message)) throw err;
      }
    }
    throw new Error('Could not generate a unique claim code');
  }

  // ----- Player API ---------------------------------------------------------

  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.get('/hunt', (req, res) => res.json(huntPayload(req.playerId)));

  const findPlayer = db.prepare('SELECT id FROM players WHERE email = ?');
  const insertPlayer = db.prepare('INSERT INTO players (email, marketing_consent) VALUES (?, ?)');
  const updateConsent = db.prepare('UPDATE players SET marketing_consent = ? WHERE id = ?');

  // Starts the hunt for an email, or picks it up again on another phone.
  api.post('/join', (req, res) => {
    const email = normaliseEmail(req.body?.email);
    const consent = req.body?.consent === true ? 1 : 0;
    let player = findPlayer.get(email);
    if (player) {
      updateConsent.run(consent, player.id);
    } else {
      if (!joinLimit(req.ip)) throw new HttpError(429, 'Too many sign-ups from this network. Please try again later.');
      player = { id: Number(insertPlayer.run(email, consent).lastInsertRowid) };
    }
    startSession(req, res, PLAYER_COOKIE, 'player', player.id, PLAYER_DAYS * 86400);
    res.json(huntPayload(player.id));
  });

  api.post('/leave', (req, res) => {
    endSession(req, res, PLAYER_COOKIE);
    res.json(huntPayload(null));
  });

  const insertScan = db.prepare('INSERT OR IGNORE INTO scans (player_id, checkpoint_id) VALUES (?, ?)');
  api.post('/scan', requirePlayer, (req, res) => {
    const status = huntStatus();
    if (status !== 'open') return res.json({ result: status, hunt: huntPayload(req.playerId) });

    const cp = byCode.get(String(req.body?.code ?? '').trim());
    if (!cp) {
      if (!badScanLimit(req.playerId)) throw new HttpError(429, 'Too many wrong codes. Please try again later.');
      return res.json({ result: 'invalid', hunt: huntPayload(req.playerId) });
    }

    let won = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const added = insertScan.run(req.playerId, cp.id).changes > 0;
      if (added && foundIds(req.playerId).size >= config.required && !prizeFor.get(req.playerId)) {
        awardPrize(req.playerId);
        won = true;
      }
      db.exec('COMMIT');
      res.json({
        result: added ? 'found' : 'already',
        won,
        checkpoint: { name: cp.name, message: cp.found },
        hunt: huntPayload(req.playerId),
      });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  // ----- Staff API ----------------------------------------------------------

  api.post('/staff/login', (req, res) => {
    if (!staffPassword && !adminPassword) {
      throw new HttpError(503, 'Staff sign-in is not set up. Set STAFF_PASSWORD and ADMIN_PASSWORD on the server.');
    }
    if (!loginLimit(req.ip)) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
    const password = String(req.body?.password ?? '');
    const role = passwordMatches(password, adminPassword) ? 'admin' : passwordMatches(password, staffPassword) ? 'staff' : null;
    if (!role) throw new HttpError(401, 'That password is not right');
    startSession(req, res, STAFF_COOKIE, role, null, STAFF_HOURS * 3600);
    res.json({ role });
  });

  api.post('/staff/logout', (req, res) => {
    endSession(req, res, STAFF_COOKIE);
    res.json({ ok: true });
  });

  api.get('/staff/me', requireStaff, (req, res) => res.json({ role: req.staffRole }));

  const playerByEmail = db.prepare('SELECT id, email FROM players WHERE email = ?');
  const playerByClaim = db.prepare('SELECT p.id, p.email FROM prizes z JOIN players p ON p.id = z.player_id WHERE z.claim_code = ?');

  function staffView(player) {
    return {
      email: player.email,
      found: foundIds(player.id).size,
      required: config.required,
      prize: prizeJson(prizeFor.get(player.id)),
    };
  }

  // q is a claim code (BOO-XXXXX, with or without the BOO-) or an email.
  api.get('/staff/lookup', requireStaff, (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) throw new HttpError(400, 'Enter a claim code or email');
    const player = q.includes('@') ? playerByEmail.get(q.toLowerCase()) : playerByClaim.get(normaliseClaimCode(q));
    if (!player) throw new HttpError(404, q.includes('@') ? 'Nobody has played with that email' : 'No prize has that claim code');
    res.json(staffView(player));
  });

  const claimPrize = db.prepare(`UPDATE prizes SET claimed_at = datetime('now') WHERE claim_code = ? AND claimed_at IS NULL`);
  api.post('/staff/claim', requireStaff, (req, res) => {
    const code = normaliseClaimCode(req.body?.claimCode);
    const player = playerByClaim.get(code);
    if (!player) throw new HttpError(404, 'No prize has that claim code');
    if (claimPrize.run(code).changes === 0) {
      const when = prizeFor.get(player.id).claimed_at;
      throw new HttpError(409, `This prize was already claimed on ${new Date(utcIso(when)).toLocaleString('en-GB', { timeZone: config.timeZone || 'Europe/London' })}`);
    }
    res.json(staffView(player));
  });

  // ----- Admin API ----------------------------------------------------------

  api.get('/admin/stats', requireAdmin, (_req, res) => {
    const scanCounts = new Map(
      db.prepare('SELECT checkpoint_id, COUNT(*) AS n FROM scans GROUP BY checkpoint_id').all().map((r) => [r.checkpoint_id, r.n]),
    );
    res.json({
      status: huntStatus(),
      players: db.prepare(`SELECT COUNT(*) AS n FROM players WHERE email NOT LIKE 'deleted-%@invalid'`).get().n,
      totalPlayers: db.prepare('SELECT COUNT(*) AS n FROM players').get().n,
      marketingOptIns: db.prepare('SELECT COUNT(*) AS n FROM players WHERE marketing_consent = 1').get().n,
      winners: db.prepare('SELECT COUNT(*) AS n FROM prizes').get().n,
      claimed: db.prepare('SELECT COUNT(*) AS n FROM prizes WHERE claimed_at IS NOT NULL').get().n,
      checkpoints: config.checkpoints.map((c, i) => ({ number: i + 1, name: c.name, scans: scanCounts.get(c.id) || 0 })),
    });
  });

  api.get('/admin/checkpoints', requireAdmin, (_req, res) => {
    res.json({
      name: config.name,
      required: config.required,
      prize: config.prize,
      checkpoints: config.checkpoints.map((c, i) => ({ number: i + 1, name: c.name, clue: c.clue, code: c.code })),
    });
  });

  api.get('/admin/export.csv', requireAdmin, (_req, res) => {
    const rows = db.prepare(`
      SELECT p.email, p.marketing_consent, p.created_at,
             (SELECT COUNT(*) FROM scans s WHERE s.player_id = p.id) AS scans,
             z.claim_code, z.won_at, z.claimed_at
      FROM players p LEFT JOIN prizes z ON z.player_id = p.id
      WHERE p.email NOT LIKE 'deleted-%@invalid'
      ORDER BY p.created_at`).all();
    const header = ['email', 'marketing_opt_in', 'started', 'checkpoints_found', 'claim_code', 'won', 'claimed'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.email, r.marketing_consent ? 'yes' : 'no', r.created_at, r.scans, r.claim_code, r.won_at, r.claimed_at].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hunt-players.csv"');
    res.send(lines.join('\r\n') + '\r\n');
  });

  // After the hunt: replace the emails of people who didn't opt in to marketing,
  // keeping their scans so the totals stay the same.
  api.post('/admin/delete-emails', requireAdmin, (_req, res) => {
    const result = db.prepare(`
      UPDATE players SET email = 'deleted-' || id || '@invalid'
      WHERE marketing_consent = 0 AND email NOT LIKE 'deleted-%@invalid'`).run();
    db.exec(`DELETE FROM sessions WHERE kind = 'player'`);
    res.json({ deleted: result.changes });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
