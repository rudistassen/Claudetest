import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import config from '../hunt.config.js';
import { openDb } from '../src/db.js';
import { createApp, validateConfig } from '../src/server.js';

let clock = new Date('2026-10-26T14:00:00Z');
let server;
let base;

before(async () => {
  const app = createApp(openDb(':memory:'), config, {
    staffPassword: 'staff-pass',
    adminPassword: 'admin-pass',
    now: () => clock,
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api/`;
});
after(() => server.close());

// A browser-like client that keeps its own cookies.
function client() {
  const jar = new Map();
  return async (path, body) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data };
  };
}

const codes = config.checkpoints.map((c) => c.code);

describe('customers', () => {
  test('never sees checkpoint codes', async () => {
    const { data } = await client()('hunt');
    assert.equal(data.player, null);
    assert.equal(data.checkpoints.length, config.checkpoints.length);
    assert.ok(!JSON.stringify(data).includes(codes[0]));
    assert.equal(data.checkpoints[0].name, null);
  });

  test('must enter a valid email before scanning', async () => {
    const c = client();
    assert.equal((await c('scan', { code: codes[0] })).status, 401);
    const bad = await c('join', { email: 'not-an-email' });
    assert.equal(bad.status, 400);
  });

  test('collects checkpoints and wins once at the required number', async () => {
    const c = client();
    const join = await c('join', { email: '  Winner@Example.com ', consent: true });
    assert.equal(join.data.player.email, 'winner@example.com');

    for (let i = 0; i < config.required - 1; i++) {
      const r = await c('scan', { code: codes[i] });
      assert.equal(r.data.result, 'found');
      assert.equal(r.data.won, false);
    }
    assert.equal((await c('scan', { code: codes[0] })).data.result, 'already');
    assert.equal((await c('scan', { code: 'wrongcode' })).data.result, 'invalid');

    const last = await c('scan', { code: codes[config.required - 1] });
    assert.equal(last.data.won, true);
    assert.match(last.data.hunt.player.prize.code, /^BOO-[A-Z2-9]{5}$/);
    assert.equal(last.data.hunt.player.found, config.required);
    assert.equal(last.data.hunt.checkpoints[0].name, config.checkpoints[0].name);

    // An extra checkpoint after winning doesn't award a second prize.
    const extra = await c('scan', { code: codes[config.required] });
    assert.equal(extra.data.won, false);
    assert.equal(extra.data.hunt.player.prize.code, last.data.hunt.player.prize.code);
  });

  test('the same email on another phone carries on with the same progress', async () => {
    const a = client();
    await a('join', { email: 'switcher@example.com' });
    await a('scan', { code: codes[0] });
    const b = client();
    const r = await b('join', { email: 'SWITCHER@example.com' });
    assert.equal(r.data.player.found, 1);
  });

  test('scans are refused before and after the hunt dates (UK time)', async () => {
    const c = client();
    await c('join', { email: 'early@example.com' });
    clock = new Date('2026-10-23T22:59:00Z'); // 23:59 on the 23rd in London
    assert.equal((await c('scan', { code: codes[0] })).data.result, 'early');
    clock = new Date('2026-11-02T00:30:00Z');
    assert.equal((await c('scan', { code: codes[0] })).data.result, 'over');
    clock = new Date('2026-10-26T14:00:00Z');
    assert.equal((await c('scan', { code: codes[0] })).data.result, 'found');
  });

  test('too many wrong codes are blocked', async () => {
    const c = client();
    await c('join', { email: 'guesser@example.com' });
    let last;
    for (let i = 0; i < 21; i++) last = await c('scan', { code: 'guess' + i });
    assert.equal(last.status, 429);
  });
});

describe('staff', () => {
  async function winner(email) {
    const c = client();
    await c('join', { email });
    let r;
    for (const code of codes.slice(0, config.required)) r = await c('scan', { code });
    return { c, code: r.data.hunt.player.prize.code };
  }

  test('need a password', async () => {
    const s = client();
    assert.equal((await s('staff/lookup?q=BOO-AAAAA')).status, 401);
    assert.equal((await s('staff/login', { password: 'nope' })).status, 401);
    assert.equal((await s('staff/login', { password: 'staff-pass' })).data.role, 'staff');
    assert.equal((await s('admin/stats')).status, 403);
  });

  test('look up and claim a prize exactly once', async () => {
    const { c, code } = await winner('claimer@example.com');
    const s = client();
    await s('staff/login', { password: 'staff-pass' });

    const byCode = await s('staff/lookup?q=' + code.slice(4).toLowerCase());
    assert.equal(byCode.data.email, 'claimer@example.com');
    assert.equal(byCode.data.prize.claimedAt, null);
    assert.equal((await s('staff/lookup?q=claimer@example.com')).data.prize.code, code);

    const claimed = await s('staff/claim', { claimCode: code });
    assert.ok(claimed.data.prize.claimedAt);
    const again = await s('staff/claim', { claimCode: code });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /already claimed/);

    // The customer's page now shows it as claimed.
    assert.ok((await c('hunt')).data.player.prize.claimedAt);
  });

  test('a non-winner shows as not won', async () => {
    const c = client();
    await c('join', { email: 'halfway@example.com' });
    await c('scan', { code: codes[0] });
    const s = client();
    await s('staff/login', { password: 'staff-pass' });
    const r = await s('staff/lookup?q=halfway@example.com');
    assert.equal(r.data.found, 1);
    assert.equal(r.data.prize, null);
    assert.equal((await s('staff/claim', { claimCode: 'BOO-ZZZZZ' })).status, 404);
  });
});

describe('admin', () => {
  test('stats, posters, CSV export and deleting emails', async () => {
    const a = client();
    assert.equal((await a('admin/checkpoints')).status, 401);
    await a('staff/login', { password: 'admin-pass' });

    const cps = await a('admin/checkpoints');
    assert.equal(cps.data.checkpoints[0].code, codes[0]);

    const stats = await a('admin/stats');
    assert.ok(stats.data.players >= 5);
    assert.ok(stats.data.winners >= 2);
    assert.ok(stats.data.claimed >= 1);

    const csv = await a('admin/export.csv');
    assert.match(csv.data, /^email,marketing_opt_in/);
    assert.match(csv.data, /winner@example\.com,yes/);

    const del = await a('admin/delete-emails', {});
    assert.ok(del.data.deleted >= 4);
    const after = await a('admin/export.csv');
    assert.match(after.data, /winner@example\.com/); // opted in, so kept
    assert.doesNotMatch(after.data, /claimer@example\.com/);
    assert.equal((await a('admin/stats')).data.winners, stats.data.winners);
  });
});

test('config checks catch mistakes', () => {
  assert.doesNotThrow(() => validateConfig(config));
  const dupe = { ...config, checkpoints: [...config.checkpoints, { ...config.checkpoints[0] }] };
  assert.throws(() => validateConfig(dupe), /Two checkpoints/);
  assert.throws(() => validateConfig({ ...config, required: 99 }), /required/);
});
