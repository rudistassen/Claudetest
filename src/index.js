import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { cleanEnv, DEMO_PASSWORD, ensureAdmin, isEmpty, lockDemoAccounts, seedAdmin, seedDemo, seedSafetyTasks } from './seed.js';
import { createApp, publicDir } from './server.js';
import { xeroConfig } from './xero.js';
import { appVersion } from './app-version.js';
import { brevoMailer, emailConfig } from './email.js';
import { invoiceReaderFromEnv } from './invoice-reader.js';
import { careersMailboxConfig, eventsMailboxConfig, graphMailbox, mailboxConfig, mailboxSetup } from './mailbox.js';
import { startEventsInbox } from './events.js';
import { enquiryReaderFromEnv } from './enquiry-reader.js';
import { startCareersInbox } from './careers-inbox.js';
import { startInvoiceInbox } from './invoice-inbox.js';
import { googlePlaces, placesConfig, startReviewSync } from './google-reviews.js';
import { startReportScheduler } from './reports.js';
import { SquareClient, squareConfig, startAutoSync, syncSales } from './square.js';
import { addDays, today } from './util.js';

const args = new Set(process.argv.slice(2));
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'cafe.db');

if (args.has('--reset') && fs.existsSync(dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

const adminEmail = cleanEnv(process.env.ADMIN_EMAIL);
const adminPassword = cleanEnv(process.env.ADMIN_PASSWORD);

if (isEmpty(db)) {
  const email = adminEmail || 'admin@cafe.local';
  const password = adminPassword || DEMO_PASSWORD;
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
} else {
  // The database already existed, e.g. a hosting platform started the app before ADMIN_EMAIL was set.
  const admin = ensureAdmin(db, { email: adminEmail, password: adminPassword });
  if (admin) console.log(`Admin account ${adminEmail} ${admin}.`);
}

// Running for real (no demo): nobody may keep signing in with the published demo password.
if (process.env.SEED_DEMO === 'false') {
  const locked = lockDemoAccounts(db, { keepEmail: adminEmail });
  if (locked) console.log(`Switched off ${locked} account(s) still using the demo password.`);
}

if (args.has('--seed-only')) process.exit(0);

const config = squareConfig();
const square = config ? { config, client: new SquareClient(config) } : null;
if (square) {
  console.log(`Square connected (${config.environment}); syncing sales every ${config.syncMinutes} minutes.`);
  startAutoSync(db, square.client, config);
}

// Emailed reports: fetch the latest from Square just before sending, so the figures are fresh.
const emailSettings = emailConfig();
const mailer = emailSettings ? brevoMailer(emailSettings) : null;
if (mailer) {
  console.log(`Email reports switched on (sending from ${emailSettings.from}).`);
  startReportScheduler(db, mailer, {
    beforeSend: square ? () => syncSales(db, square.client, { from: addDays(today(), -1), to: today(), triggeredBy: 'email report' }) : null,
  });
}

// Reading supplier invoices with Claude.
const invoiceReader = invoiceReaderFromEnv();
if (invoiceReader) console.log(`Invoice reading switched on (${invoiceReader.model}).`);

const port = Number(process.env.PORT) || 3000;
// The shared invoice inbox (Microsoft 365): emailed invoices are read and added automatically.
const inboxSettings = mailboxConfig();
const mailbox = inboxSettings ? graphMailbox(inboxSettings) : null;
if (mailbox && invoiceReader) {
  console.log(`Invoice inbox connected (${inboxSettings.address}); checking every ${inboxSettings.minutes} minutes.`);
  startInvoiceInbox(db, { mailbox, reader: invoiceReader, minutes: inboxSettings.minutes });
} else if (mailbox) console.log('Invoice inbox is set up, but needs ANTHROPIC_API_KEY to read invoices.');
else {
  // Some of the inbox settings are there but not all: say which (names only), to help spot a typo.
  const setup = mailboxSetup();
  if (setup.some((v) => v.status !== 'missing')) {
    console.log(`Invoice inbox not connected – ${setup.filter((v) => v.status !== 'ok').map((v) => `${v.name} ${v.status === 'misnamed' ? `(found "${v.found}" instead)` : v.status}`).join(', ')}.`);
  }
}

// The shared careers inbox (Microsoft 365, the same app): job applications become candidates on People → Recruitment.
const careersSettings = careersMailboxConfig();
const careers = careersSettings ? graphMailbox(careersSettings, { withAttachmentsOnly: false, label: 'careers inbox', variable: 'CAREERS_MAILBOX' }) : null;
if (careers) {
  console.log(`Careers inbox connected (${careersSettings.address}); checking every ${careersSettings.minutes} minutes.`);
  startCareersInbox(db, { mailbox: careers, minutes: careersSettings.minutes });
}

// The shared events inbox (Microsoft 365, the same app): event enquiries and the conversations about them.
const eventsSettings = eventsMailboxConfig();
const events = eventsSettings ? graphMailbox(eventsSettings, { withAttachmentsOnly: false, label: 'events inbox', variable: 'EVENTS_MAILBOX' }) : null;
// Reads each enquiry for its date, guests and so on (the same Claude API key as the invoice reader).
const enquiryReader = enquiryReaderFromEnv();
if (events) {
  console.log(`Events inbox connected (${eventsSettings.address}); checking every ${eventsSettings.minutes} minutes${enquiryReader ? ', reading each enquiry for its details' : ''}.`);
  startEventsInbox(db, { mailbox: events, reader: enquiryReader, minutes: eventsSettings.minutes });
}

// Google reviews for each site.
const placesSettings = placesConfig();
const places = placesSettings ? googlePlaces(placesSettings.key) : null;
if (places) {
  console.log(`Google reviews switched on; checking every ${placesSettings.hours} hours.`);
  startReviewSync(db, places, { hours: placesSettings.hours });
}

const version = appVersion(publicDir);
const xeroSettings = xeroConfig();
if (xeroSettings) console.log('Xero: set up – connect it under Setup → Xero.');
createApp(db, { square, mailer, invoiceReader, mailbox, careers, events, enquiryReader, places, version, xero: xeroSettings ? { config: xeroSettings } : null }).listen(port, () => console.log(`Atlas running at http://localhost:${port}`));
