import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { DEMO_PASSWORD, isEmpty, seedAdmin, seedDemo, seedSafetyTasks } from './seed.js';
import { createApp } from './server.js';
import { SquareClient, squareConfig, startAutoSync } from './square.js';

const args = new Set(process.argv.slice(2));
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'cafe.db');

if (args.has('--reset') && fs.existsSync(dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

if (isEmpty(db)) {
  const email = process.env.ADMIN_EMAIL || 'admin@cafe.local';
  const password = process.env.ADMIN_PASSWORD || DEMO_PASSWORD;
  seedAdmin(db, { email, password });
  if (process.env.SEED_DEMO === 'false') {
    seedSafetyTasks(db);
    console.log(`Created admin account ${email}. Add your locations, staff and suppliers from the Admin menu.`);
  } else {
    seedDemo(db);
    console.log('Loaded demo data (7 locations, staff, suppliers, products, rota and food safety checks).');
    console.log(`  Admin:   ${email} / ${password}`);
    console.log(`  Manager: manager1@cafe.local / ${DEMO_PASSWORD}   (manager1..manager7)`);
    console.log(`  Staff:   staff1@cafe.local / ${DEMO_PASSWORD}     (staff1..staff7)`);
  }
}

if (args.has('--seed-only')) process.exit(0);

const config = squareConfig();
const square = config ? { config, client: new SquareClient(config) } : null;
if (square) {
  console.log(`Square connected (${config.environment}); syncing sales every ${config.syncMinutes} minutes.`);
  startAutoSync(db, square.client, config);
}

const port = Number(process.env.PORT) || 3000;
createApp(db, { square }).listen(port, () => console.log(`Cafe Ops running at http://localhost:${port}`));
