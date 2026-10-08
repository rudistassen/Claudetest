import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDb } from '../src/db.js';

const dir = mkdtempSync(join(tmpdir(), 'atlas-sb-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('sales budgets saved as net before they became gross are turned into gross at the site’s own rate', () => {
  const file = join(dir, 'a.db');
  let db = openDb(file);
  db.exec(`INSERT INTO locations (id, name) VALUES (1, 'Harbour'), (2, 'New site')`);
  // Harbour: net is 80% of gross. The new site has no sales, so 20% VAT is used.
  db.prepare(`INSERT INTO sales_daily (location_id, date, net_sales, gross_sales, orders) VALUES (1, date('now', '-3 days'), 800, 1000, 10)`).run();
  db.exec(`INSERT INTO sales_budgets (location_id, date, amount) VALUES (1, '2030-01-05', 2000), (2, '2030-01-05', 1000)`);
  db.exec('PRAGMA user_version = 10');
  db.close();
  db = openDb(file);
  assert.deepEqual(db.prepare('SELECT location_id, amount FROM sales_budgets ORDER BY location_id').all().map((r) => [r.location_id, r.amount]), [[1, 2500], [2, 1200]]);
  db.close();
  // Only once.
  db = openDb(file);
  assert.equal(db.prepare('SELECT amount FROM sales_budgets WHERE location_id = 1').get().amount, 2500);
  db.close();
});
