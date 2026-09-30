// Inviting staff to Brewly and "forgot password": both email a one-off link to a page where the person chooses
// their own password, then they're signed in. Invite links last 14 days, reset links 2 hours; each works once.
// The Staff page shows who hasn't been invited, who's been invited but not signed in yet, and who has joined.
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, requirePerm, startSession, validatePassword } from './auth.js';
import { appUrl } from './reports.js';
import { squareTeamUrl } from './square-staff.js';
import { badRequest, forbidden, HttpError, id, str } from './util.js';

const LIFETIME = { invite: '+14 days', reset: '+2 hours' };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Where links in emails point. Never taken from a stranger's request, so a reset email can't be sent elsewhere. */
function baseUrl(req, { trusted }) {
  const configured = appUrl();
  if (configured) return configured;
  const host = req.get('host') ?? '';
  if (trusted || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `${req.protocol}://${host}`;
  return null;
}

/** A new link for someone (older unused links of the same kind stop working). Returns the link's secret. */
export function createToken(db, userId, purpose, createdBy = null) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).run(userId, purpose);
  db.prepare(`INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at, created_by) VALUES (?, ?, ?, datetime('now', ?), ?)`)
    .run(hashToken(token), userId, purpose, LIFETIME[purpose], createdBy);
  db.prepare(`DELETE FROM password_tokens WHERE expires_at < datetime('now', '-30 days')`).run();
  return token;
}

function findToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.prepare(`SELECT t.*, u.name, u.email FROM password_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > datetime('now') AND u.active = 1`).get(hashToken(token)) ?? null;
}

const linkFor = (base, token) => `${base}/#/set-password?token=${token}`;

function inviteEmail({ name, inviter, site, link }) {
  const first = String(name).split(' ')[0];
  return {
    subject: 'You’re invited to Brewly',
    text: `Hi ${first},\n\n${inviter} has invited you to Brewly${site ? ` for ${site}` : ''} – where you’ll see your rota, company news and more.\n\nChoose your password here (the link works for 14 days):\n${link}\n\nThen add Brewly to your phone’s home screen so it’s always to hand.\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;color:#0c1014">
      <h1 style="font-size:22px">Welcome to Brewly ☕</h1>
      <p>Hi ${escHtml(first)},</p>
      <p>${escHtml(inviter)} has invited you to Brewly${site ? ` for <strong>${escHtml(site)}</strong>` : ''} – where you’ll see your rota, company news and more.</p>
      <p style="margin:28px 0"><a href="${escHtml(link)}" style="background:#0095f6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Choose your password</a></p>
      <p style="color:#737373;font-size:13px">The button works for 14 days. Once you’re in, add Brewly to your phone’s home screen so it’s always to hand.</p>
      <p style="color:#737373;font-size:13px">Button not working? Copy this link into your browser:<br>${escHtml(link)}</p></div>`,
  };
}

function resetEmail({ name, link }) {
  const first = String(name).split(' ')[0];
  return {
    subject: 'Reset your Brewly password',
    text: `Hi ${first},\n\nChoose a new Brewly password here (the link works for 2 hours):\n${link}\n\nIf you didn’t ask for this, you can ignore this email – your password hasn’t changed.\n`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;color:#0c1014">
      <p>Hi ${escHtml(first)},</p>
      <p>Someone (hopefully you) asked to reset your Brewly password.</p>
      <p style="margin:28px 0"><a href="${escHtml(link)}" style="background:#0095f6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
      <p style="color:#737373;font-size:13px">The button works for 2 hours. If you didn’t ask for this, ignore this email – your password hasn’t changed.</p>
      <p style="color:#737373;font-size:13px">Button not working? Copy this link into your browser:<br>${escHtml(link)}</p></div>`,
  };
}

// "Forgot password" requests are limited, so nobody can flood someone's inbox.
const FORGOT_WINDOW_MS = 60 * 60 * 1000;
const FORGOT_MAX = { ip: 10, email: 3 };
const forgotLog = new Map();
function forgotAllowed(keys, now) {
  let ok = true;
  for (const [key, max] of keys) {
    const list = (forgotLog.get(key) ?? []).filter((t) => now - t < FORGOT_WINDOW_MS);
    if (list.length >= max) ok = false;
    forgotLog.set(key, [...list, now]);
  }
  return ok;
}

/** Routes anyone can use (before signing in): forgot password, and opening / using an emailed link. */
export function registerPasswordRoutes(router, db, mailer) {
  router.post('/auth/forgot', async (req, res) => {
    const email = str(req.body?.email, 'Email', { required: true, max: 200 });
    const reply = { ok: true, email_ready: !!mailer };
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ? AND active = 1').get(email);
    // The answer is the same whether or not the email has an account, so it can't be used to find out who works here.
    if (!mailer || !user || !forgotAllowed([[`ip:${req.ip}`, FORGOT_MAX.ip], [`email:${email.toLowerCase()}`, FORGOT_MAX.email]], Date.now())) return res.json(reply);
    const base = baseUrl(req, { trusted: false });
    if (!base) return res.json(reply);
    const link = linkFor(base, createToken(db, user.id, 'reset'));
    try {
      await mailer.send({ to: user.email, name: user.name, ...resetEmail({ name: user.name, link }) });
    } catch (err) {
      console.error('Password reset email:', err.message);
    }
    res.json(reply);
  });

  router.get('/auth/token', (req, res) => {
    const t = findToken(db, req.query.token);
    if (!t) throw new HttpError(404, 'This link has expired or has already been used.');
    res.json({ purpose: t.purpose, name: t.name, email: t.email });
  });

  router.post('/auth/token', (req, res) => {
    const t = findToken(db, req.body?.token);
    if (!t) throw new HttpError(404, 'This link has expired or has already been used.');
    const password = validatePassword(req.body?.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), t.user_id);
    db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(t.user_id);
    // Signed out everywhere else, in case the old password was known to someone.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id);
    res.json({ user: startSession(db, req, res, t.user_id) });
  });
}

/** Staff page: send invites (or copy an invite link to send another way). */
export function registerInviteRoutes(router, db, mailer, { demo = false, square = null } = {}) {
  // What the Staff page can offer: emailed invites, and adding people to Square.
  router.get('/invites/settings', requirePerm('staff.manage'), (_req, res) => res.json({ email_ready: !!mailer, square_ready: !!square, square_team_url: square ? squareTeamUrl(square.config.environment) : null }));

  // Managers can invite the staff they manage (not admins); admins can invite anyone.
  const invitable = (req, userId) => {
    const u = db.prepare('SELECT id, name, email, role, location_id, active FROM users WHERE id = ?').get(userId);
    if (!u) throw badRequest('Someone on the list no longer exists – reload the page');
    if (req.user.role !== 'admin' && (u.role === 'admin' || !req.user.site_ids.includes(u.location_id))) {
      throw forbidden(`You can’t invite ${u.name}`);
    }
    return u;
  };

  router.post('/users/invite', requirePerm('staff.manage'), async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((x) => id(x, 'ids')))];
    if (!ids.length) throw badRequest('Choose at least one person');
    if (ids.length > 500) throw badRequest('Invite at most 500 people at a time');
    const people = ids.map((userId) => invitable(req, userId));
    const base = baseUrl(req, { trusted: true });
    const site = (locationId) => db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId)?.name ?? null;

    // One person, as a link to copy (to send by text or WhatsApp) instead of an email.
    if (req.body.link_only) {
      if (people.length !== 1) throw badRequest('Copy one person’s link at a time');
      const [u] = people;
      if (!u.active) throw badRequest(`${u.name} is deactivated – make them active first`);
      const link = linkFor(base, createToken(db, u.id, 'invite', req.user.id));
      db.prepare(`UPDATE users SET invited_at = datetime('now') WHERE id = ?`).run(u.id);
      return res.json({ link });
    }

    if (!mailer) throw badRequest('Email isn’t set up yet, so invites can’t be emailed. Use “Copy invite link” on a person instead, or set up email (BREVO_API_KEY and EMAIL_FROM).');
    const result = { sent: [], skipped: [], failed: [] };
    for (const u of people) {
      if (!u.active) { result.skipped.push({ id: u.id, name: u.name, reason: 'deactivated' }); continue; }
      if ((!demo && /@(cafe\.local|example\.(com|org|net))$/i.test(u.email)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) {
        result.skipped.push({ id: u.id, name: u.name, reason: 'no real email address' });
        continue;
      }
      const link = linkFor(base, createToken(db, u.id, 'invite', req.user.id));
      try {
        await mailer.send({ to: u.email, name: u.name, ...inviteEmail({ name: u.name, inviter: req.user.name, site: site(u.location_id), link }) });
        db.prepare(`UPDATE users SET invited_at = datetime('now') WHERE id = ?`).run(u.id);
        result.sent.push({ id: u.id, name: u.name });
      } catch (err) {
        result.failed.push({ id: u.id, name: u.name, reason: err.message });
        // Email refused outright (a wrong key or sender): stop rather than fail for everyone.
        if (err.status === 502 && /check (BREVO_API_KEY|EMAIL_FROM)/.test(err.message)) break;
      }
    }
    res.json(result);
  });
}
