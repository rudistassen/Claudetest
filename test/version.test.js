import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appVersion } from '../src/app-version.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

test('the app version is available without signing in, and screens are always rechecked', async () => {
  const server = createApp(openDb(':memory:'), { version: 'abc123' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { version: 'abc123' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const p of ['/', '/css/styles.css', '/js/app.js']) {
      assert.equal((await fetch(`${base}${p}`)).headers.get('cache-control'), 'no-cache', p);
    }
  } finally {
    server.close();
  }
});

test('the version changes when a screen file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-'));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{}');
  const v1 = appVersion(dir);
  assert.equal(appVersion(dir), v1);
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{color:red}');
  assert.notEqual(appVersion(dir), v1);
  fs.rmSync(dir, { recursive: true });
});
