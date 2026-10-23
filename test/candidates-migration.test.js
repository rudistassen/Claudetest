import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { openDb } from '../src/db.js';

const dir = mkdtempSync(join(tmpdir(), 'brewly-cand-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The People tables as first released, before candidates could come from the careers inbox.
const OLD = `CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE vacancies (id INTEGER PRIMARY KEY, location_id INTEGER, title TEXT);
  CREATE TABLE candidates (id INTEGER PRIMARY KEY, vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE, name TEXT NOT NULL,
    email TEXT, phone TEXT, stage TEXT NOT NULL DEFAULT 'applied', next_step_on TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO vacancies VALUES (1, NULL, 'Barista');
  INSERT INTO candidates (vacancy_id, name) VALUES (1, 'Sam');`;

const canSaveCv = (db, candidateId) => {
  db.prepare(`INSERT INTO candidate_files (candidate_id, file_name, file_type, size, file) VALUES (?, 'cv.pdf', 'application/pdf', 1, x'00')`).run(candidateId);
  db.prepare(`INSERT INTO careers_emails (message_id, status, candidate_id) VALUES ('m1', 'added', ?)`).run(candidateId);
};

test('updating a database from before the careers inbox keeps candidates and their links', () => {
  const file = join(dir, 'a.db');
  const d = new DatabaseSync(file);
  d.exec(OLD);
  d.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT name FROM candidates').get().name, 'Sam');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%candidates_old%' OR sql LIKE '%candidates_new%'`).get().n, 0);
  canSaveCv(db, 1);
  db.close();
});

test('a database left linked to "candidates_old" is repaired, and half-added applications are cleared', () => {
  const file = join(dir, 'b.db');
  let db = openDb(file);
  // What the first version of the change did: the CVs and careers emails ended up linked to candidates_old.
  const create = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'candidates'`).get().sql;
  db.exec(`PRAGMA foreign_keys = OFF;
    ALTER TABLE candidates RENAME TO candidates_old;
    ${create};
    INSERT INTO candidates SELECT * FROM candidates_old;
    DROP TABLE candidates_old;
    PRAGMA foreign_keys = ON;`);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE sql LIKE '%candidates_old%'`).get());
  db.exec(`INSERT INTO candidates (id, name, email, stage, source, created_at, updated_at) VALUES (1, 'Half added', 'h@example.com', 'applied', 'email', datetime('now'), datetime('now')),
    (2, 'Kept', 'k@example.com', 'interview', 'email', datetime('now'), datetime('now')), (3, 'By hand', NULL, 'applied', 'manual', datetime('now'), datetime('now'))`);
  db.close();
  db = openDb(file);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%candidates_old%'`).get().n, 0);
  assert.deepEqual(db.prepare('SELECT name FROM candidates ORDER BY id').all().map((r) => r.name), ['Kept', 'By hand']);
  canSaveCv(db, 2);
  // Still linked: deleting a candidate takes their files with them.
  db.prepare('DELETE FROM candidates WHERE id = 2').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_files').get().n, 0);
  db.close();
});
