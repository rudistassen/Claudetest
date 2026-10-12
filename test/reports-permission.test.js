import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { ALL_PERMISSIONS, DEFAULT_SETS } from '../src/permissions.js';

test('the Reporting menu is a permission; the Manager set has it and Staff doesn’t', () => {
  assert.ok(ALL_PERMISSIONS.includes('reports.view'));
  assert.ok(DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions.includes('reports.view'));
  assert.ok(!DEFAULT_SETS.find((s) => s.built_in === 'staff').permissions.includes('reports.view'));
});

test('upgrading gives the Reporting permission to everyone who could see a report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-reports-'));
  try {
    const file = join(dir, 'app.db');
    let d = openDb(file);
    d.prepare(`INSERT INTO permission_sets (name, description, permissions) VALUES ('Sales', '', '["sales.view"]'), ('Sick', '', '["rota.edit"]'), ('Floor', '', '["rota.view","safety.complete"]')`).run();
    d.prepare(`INSERT INTO users (name, email, password_hash, role, custom_permissions) VALUES ('Custom', 'c@x', 'x', 'staff', '["reviews.view"]')`).run();
    d.exec('PRAGMA user_version = 16');
    d.close();
    d = openDb(file);
    const set = (name) => JSON.parse(d.prepare('SELECT permissions FROM permission_sets WHERE name = ?').get(name).permissions);
    assert.ok(set('Sales').includes('reports.view'));
    assert.ok(set('Sick').includes('reports.view'));
    assert.ok(!set('Floor').includes('reports.view'));
    assert.ok(set('Manager').includes('reports.view'), 'the built-in Manager set');
    assert.ok(!set('Staff').includes('reports.view'));
    assert.ok(JSON.parse(d.prepare(`SELECT custom_permissions FROM users WHERE email = 'c@x'`).get().custom_permissions).includes('reports.view'));
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
