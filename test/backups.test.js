import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { backUp, backUpBeforeUpdate, disk, diskUsage, listBackups } from '../src/backups.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;
let db;
let dir;
let dbPath;
before(async () => {
  // A roomy pretend disk, so these don't depend on how full the machine running them is.
  disk.statfs = () => ({ bsize: 1, blocks: 1e12, bavail: 9e11 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-backups-'));
  dbPath = path.join(dir, 'cafe.db');
  db = openDb(dbPath);
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { backups: { dbPath } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (p, { method = 'GET' } = {}) => fetch(`${base}${p}`, { method, headers: { cookie } });
}

test('backups: admins make and download a copy of the database; nobody else can, and no other file can be fetched', async () => {
  const admin = await login('admin@cafe.local');
  const made = await (await admin('/admin/backups', { method: 'POST' })).json();
  assert.match(made.name, /^cafe-manual-\d{8}-\d{9}\.db$/);
  const list = await (await admin('/admin/backups')).json();
  assert.ok(list.available);
  assert.equal(list.backups[0].name, made.name);
  const file = await admin(`/admin/backups/${made.name}`);
  assert.equal(file.status, 200);
  const copy = path.join(dir, 'downloaded.db');
  fs.writeFileSync(copy, Buffer.from(await file.arrayBuffer()));
  const check = new DatabaseSync(copy);
  assert.ok(check.prepare('SELECT COUNT(*) AS n FROM users').get().n > 1, 'a working copy with the data in it');
  check.close();
  assert.equal((await admin('/admin/backups/..%2Fcafe.db')).status, 404, 'only our backup files');
  const staff = await login('staff1@cafe.local');
  assert.equal((await staff('/admin/backups')).status, 403);
  assert.equal((await staff(`/admin/backups/${made.name}`)).status, 403);
});

test('a copy is made before new code first runs, once per version', () => {
  assert.ok(backUpBeforeUpdate(dbPath, 'v1'));
  assert.equal(backUpBeforeUpdate(dbPath, 'v1'), null, 'not again for the same version');
  assert.ok(backUpBeforeUpdate(dbPath, 'v2'));
  assert.equal(listBackups(dbPath).filter((b) => b.kind === 'update').length, 2);
});

test('backups keep the disk under 70% full: older copies go first, and a copy is skipped when there’s no room', () => {
  const real = disk.statfs;
  const size = () => listBackups(dbPath)[0].size;
  const base = () => ['', '-wal'].reduce((n, x) => n + (fs.existsSync(dbPath + x) ? fs.statSync(dbPath + x).size : 0), 0);
  try {
    // Room for about three copies within 70% of the disk.
    const fake = (blocks) => () => {
      const used = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.endsWith('.db')).reduce((n, f) => n + fs.statSync(path.join(dir, 'backups', f)).size, 0) + base();
      return { bsize: 1, blocks, bavail: blocks - used };
    };
    disk.statfs = fake(Math.round((base() + size() * 3.2) / 0.7));
    for (let i = 0; i < 4; i++) backUp(dbPath, ['manual', 'daily', 'update', 'manual'][i]);
    const d = diskUsage(dbPath);
    assert.ok(d.used / d.total <= 0.7, `kept under 70% (${Math.round((d.used / d.total) * 100)}%)`);
    assert.ok(listBackups(dbPath).length >= 1 && listBackups(dbPath).length <= 3);
    assert.equal(listBackups(dbPath)[0].kind, 'manual', 'the newest copy is kept');
    // No room at all: nothing is made, and it says why.
    disk.statfs = fake(base() + size());
    assert.throws(() => backUp(dbPath, 'manual'), /enough space/);
    assert.equal(backUpBeforeUpdate(dbPath, 'v3'), null, 'an update still starts without one');
  } finally {
    disk.statfs = real;
  }
});
