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
