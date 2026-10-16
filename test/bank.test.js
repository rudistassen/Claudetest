import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEFAULT_SETS } from '../src/permissions.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { bankSummary, xeroDate } from '../src/xero.js';
import { fakeXeroBank, MAIN, SAVINGS } from './fake-xero-bank.js';

const calls = [];
let allow = true;
let server;
let base;
let db;
before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  const config = { clientId: 'CID', clientSecret: 'SECRET', redirectUri: 'https://atlas.test/api/xero/callback', scopes: 'offline_access accounting.invoices' };
  server = createApp(db, { xero: { config, fetch: fakeXeroBank({ calls, allowBank: () => allow }) } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, location: r.headers.get('location'), data: await r.json().catch(() => null) };
  };
}
// Signs in to Xero as the admin, with or without bank access.
async function connect(admin, bank) {
  const start = await admin(`/xero/connect${bank ? '?bank=1' : ''}`);
  const auth = new URL(start.location);
  const back = await admin(`/xero/callback?code=abc&state=${auth.searchParams.get('state')}`);
  return { scope: auth.searchParams.get('scope'), back: back.location };
}

test('reading Xero dates and the Bank Summary report', () => {
  assert.equal(xeroDate('2026-10-01T00:00:00'), '2026-10-01');
  assert.equal(xeroDate(null, '/Date(1759276800000+0000)/'), '2025-10-01');
  const s = bankSummary({ Reports: [{ Rows: [{ RowType: 'Section', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Current', Attributes: [{ Id: 'accountID', Value: 'A1' }] }, { Value: '1,000.00' }, { Value: '50' }, { Value: '20' }, { Value: '1,030.00' }] }] }] }] });
  assert.deepEqual(s.get('A1'), { opening: 1000, received: 50, spent: 20, closing: 1030 });
});

test('bank: only once an admin allows it, read only, and only for people with the Bank permission', async () => {
  assert.ok(!DEFAULT_SETS.find((s) => s.built_in === 'manager').permissions.includes('bank.view'), 'managers don’t get it by default');
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  assert.equal((await manager('/bank')).status, 403);

  // Connected for bills only: Atlas doesn't ask Xero for bank data.
  const plain = await connect(admin, false);
  assert.ok(!plain.scope.includes('banktransactions'));
  let bank = (await admin('/bank')).data;
  assert.deepEqual([bank.connected, bank.bank_access, bank.accounts.length], [true, false, 0]);
  assert.equal((await admin(`/bank/${MAIN}/lines`)).status, 400);

  // Allowing it asks Xero for read-only bank scopes (and keeps them when reconnecting).
  const allowed = await connect(admin, true);
  assert.ok(allowed.scope.includes('accounting.banktransactions.read') && allowed.scope.includes('accounting.payments.read') && allowed.scope.includes('accounting.reports.banksummary.read'));
  assert.ok(allowed.scope.includes('accounting.invoices'));
  assert.match(allowed.back, /bank=1/);
  assert.ok((await connect(admin, false)).scope.includes('accounting.banktransactions.read'), 'kept on reconnect');

  bank = (await admin('/bank')).data;
  assert.equal(bank.bank_access, true);
  const main = bank.accounts.find((a) => a.id === MAIN);
  assert.deepEqual([main.name, main.number_last4, main.balance], ['Business Current Account', '5678', 26730.25]);
  assert.equal(bank.accounts.find((a) => a.id === SAVINGS).balance, 50000);

  const r = (await admin(`/bank/${MAIN}/lines`)).data;
  // Deleted ones, other accounts and anything outside the dates are left out; newest first.
  assert.deepEqual(r.lines.map((l) => l.who), ['Square', 'British Gas', 'Bidfood', 'To savings', 'Smith wedding']);
  const gas = r.lines.find((l) => l.who === 'British Gas');
  assert.deepEqual([gas.amount_out, gas.amount_in, gas.reconciled, gas.kind], [86.5, null, false, 'Spend money']);
  const bill = r.lines.find((l) => l.who === 'Bidfood');
  assert.deepEqual([bill.kind, bill.amount_out, bill.details], ['Bill paid', 412.8, 'Bill INV-2231']);
  assert.equal(r.lines.find((l) => l.who === 'Smith wedding').amount_in, 650);
  assert.equal(r.money_in, 3770.4);
  assert.equal(r.money_out, 1499.3);
  assert.equal(r.unreconciled, 2);
  // Nothing is ever sent to Xero's bank endpoints except reads.
  assert.ok(calls.filter((c) => /BankTransactions|Payments|BankSummary/.test(c.path)).every((c) => c.method === 'GET'));

  // Bad requests.
  assert.equal((await admin('/bank/not-an-account/lines')).status, 400);
  assert.equal((await admin(`/bank/${MAIN}/lines?from=2024-01-01&to=2026-01-01`)).status, 400);

  // Someone given the Bank permission can see it; that's all it needs.
  db.prepare('UPDATE users SET custom_permissions = ? WHERE email = ?').run(JSON.stringify(['bank.view']), 'manager1@cafe.local');
  assert.equal((await manager('/bank')).data.accounts.length, 2);
  assert.equal((await manager('/xero')).status, 403);

  // If Xero stops allowing it, Atlas says so and asks an admin to allow it again.
  allow = false;
  await admin('/xero/bank-off', { method: 'POST' });
  assert.equal((await admin('/bank')).data.bank_access, false);
  await connect(admin, true);
  const refused = (await admin('/bank')).data;
  assert.match(refused.error, /allow it again/);
  assert.equal((await admin('/bank')).data.bank_access, false);
  allow = true;
});
