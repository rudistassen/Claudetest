import fs from 'node:fs';
import path from 'node:path';
import config from '../hunt.config.js';
import { makeCodes, parseCodes, withCodes } from './codes.js';
import { openDb } from './db.js';
import { createApp } from './server.js';

let huntConfig;
try {
  huntConfig = withCodes(config, parseCodes(process.env.HUNT_CODES));
} catch (err) {
  console.error(err.message);
  console.error('Set the HUNT_CODES variable to one code per checkpoint. Here is a new set you can use:');
  console.error(`HUNT_CODES=${makeCodes(config)}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'hunt.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

const staffPassword = process.env.STAFF_PASSWORD || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (!staffPassword || !adminPassword) {
  console.warn('STAFF_PASSWORD and/or ADMIN_PASSWORD are not set, so that staff sign-in is turned off.');
}
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DB_PATH) {
  console.warn('DB_PATH is not set. Add a Railway volume and set DB_PATH to a file on it, or data is lost on every deploy.');
}

const app = createApp(db, huntConfig, { staffPassword, adminPassword });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`${config.name} running on http://localhost:${port}`));
