import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin } from '../src/seed.js';
import { createApp, trustProxy } from '../src/server.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

const login = (email, password) => fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
});

test('too many wrong passwords for an account locks it for a while, even with the right one', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('admin@cafe.local', 'wrong-password')).status, 401);
  const blocked = await login('admin@cafe.local', DEMO_PASSWORD);
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Too many failed sign-in attempts\. Try again in 15 minutes/);
});

test('trusts the hosting platform proxy only when hosted or told to', () => {
  assert.equal(trustProxy({}), 'loopback');
  assert.equal(trustProxy({ RAILWAY_ENVIRONMENT: 'production' }), 1);
  assert.equal(trustProxy({ RENDER: 'true' }), 1);
  assert.equal(trustProxy({ TRUST_PROXY: '2' }), 2);
});

test('a hosted app started before its settings were added still creates your admin and locks the demo accounts', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { verifyPassword } = await import('../src/auth.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-start-'));
  const dbPath = path.join(dir, 'cafe.db');
  const start = (env) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js', '--seed-only'], {
    env: { PATH: process.env.PATH, DB_PATH: dbPath, ...env }, encoding: 'utf8',
  });
  try {
    start({}); // first start: no settings yet, so demo data
    const out = start({ ADMIN_EMAIL: ' "Rudi@Example.co.uk" ', ADMIN_PASSWORD: '"a-Strong-pass-123"', SEED_DEMO: 'false' });
    assert.match(out, /Admin account Rudi@Example\.co\.uk created/);
    assert.match(out, /Switched off \d+ account\(s\) still using the demo password/);

    const db = openDb(dbPath);
    const me = db.prepare(`SELECT * FROM users WHERE email = 'rudi@example.co.uk'`).get();
    assert.equal(me.role, 'admin');
    assert.equal(me.active, 1);
    assert.ok(verifyPassword('a-Strong-pass-123', me.password_hash), 'quotes around the value are ignored');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE active = 1`).get().n, 1, 'only you can sign in');
    db.close();

    const again = start({ ADMIN_EMAIL: 'rudi@example.co.uk', ADMIN_PASSWORD: 'something-else', SEED_DEMO: 'false' });
    assert.doesNotMatch(again, /Admin account/, 'an existing account is left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
