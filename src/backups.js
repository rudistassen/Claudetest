// Backups of the database (Setup → Backups). Copies go in a "backups" folder next to the database file (on Railway,
// the same volume): one before each update (when the app starts on new code, before anything in the database is
// changed), one each night, and any an admin makes by hand. Older ones are cleared out so the volume doesn't fill up.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KEEP = { update: 5, daily: 7, manual: 5 };
const NAME = /^cafe-(update|daily|manual)-(\d{8})-(\d{6})(\d{3})?\.db$/;
const stamp = () => new Date().toISOString().slice(0, 23).replace(/[-:.]/g, '').replace('T', '-');

export const backupDir = (dbPath) => path.join(path.dirname(dbPath), 'backups');

/** The saved copies, newest first: [{ name, kind, at (ISO), size (bytes) }]. */
export function listBackups(dbPath) {
  const dir = backupDir(dbPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const m = NAME.exec(name);
    if (!m) return null;
    const [d, t, ms = '000'] = [m[2], m[3], m[4]];
    return { name, kind: m[1], key: `${d}${t}${ms}`, at: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`, size: fs.statSync(path.join(dir, name)).size };
  }).filter(Boolean).sort((a, b) => b.key.localeCompare(a.key));
}

/** A saved copy's full path, or null when the name isn't one of ours (so nothing else on the disk can be fetched). */
export function backupPath(dbPath, name) {
  if (!NAME.test(String(name ?? ''))) return null;
  const file = path.join(backupDir(dbPath), name);
  return fs.existsSync(file) ? file : null;
}

function prune(dbPath, kind) {
  for (const b of listBackups(dbPath).filter((x) => x.kind === kind).slice(KEEP[kind])) fs.rmSync(path.join(backupDir(dbPath), b.name), { force: true });
}

/** Copies the database (a consistent copy, even while it's in use). db: an open database, or null to open the file. */
export function backUp(dbPath, kind, db = null) {
  fs.mkdirSync(backupDir(dbPath), { recursive: true });
  const name = `cafe-${kind}-${stamp()}.db`;
  const source = db ?? new DatabaseSync(dbPath);
  try { source.prepare('VACUUM INTO ?').run(path.join(backupDir(dbPath), name)); } finally { if (!db) source.close(); }
  prune(dbPath, kind);
  return name;
}

/**
 * Before the app opens the database on new code: if this code hasn't run against it before (fingerprint changed),
 * keep a copy first – updates can change how things are stored, and can't be undone without one.
 */
export function backUpBeforeUpdate(dbPath, fingerprint) {
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).size) return null;
  const marker = path.join(backupDir(dbPath), 'last-version.txt');
  const last = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
  if (last === fingerprint) return null;
  const name = backUp(dbPath, 'update');
  fs.writeFileSync(marker, fingerprint);
  return name;
}

/** A copy each night (checked hourly; made once a day, in the early hours or as soon after as the app is running). */
export function startNightlyBackups(db, dbPath) {
  const tick = () => {
    try {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      if (new Date().getUTCHours() < 2) return;
      if (listBackups(dbPath).some((b) => b.kind === 'daily' && b.name.includes(`-${day}-`))) return;
      console.log(`Nightly backup: ${backUp(dbPath, 'daily', db)}`);
    } catch (err) { console.error(`Nightly backup failed: ${err.message}`); }
  };
  setTimeout(tick, 60 * 1000);
  return setInterval(tick, 60 * 60 * 1000);
}
