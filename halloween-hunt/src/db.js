import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- kind: 'player' (player_id set), 'staff' or 'admin'.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('player', 'staff', 'admin')),
  player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS prizes (
  player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  claim_code TEXT NOT NULL UNIQUE,
  won_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
