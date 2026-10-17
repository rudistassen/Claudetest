// Reporting → Bank: the business's bank accounts in Xero, their balances, and money in and out – read only, straight
// from Xero (nothing is kept in Atlas). An admin allows it once under Setup → Xero.
import { requirePerm } from '../auth.js';
import { addDays, badRequest, date, today } from '../util.js';

const MAX_DAYS = 366;

export function registerBankRoutes(router, db, xero) {
  const status = () => ({
    configured: !!xero,
    connected: !!xero?.connected(),
    bank_access: !!xero?.connected() && xero.bankAllowed(),
  });

  // The accounts and their balances (or why they can't be shown yet).
  router.get('/bank', requirePerm('bank.view'), async (req, res) => {
    const s = status();
    if (!s.bank_access) return res.json({ ...s, accounts: [] });
    try {
      res.json({ ...s, accounts: await xero.bankAccounts(today()), as_of: today() });
    } catch (err) {
      res.json({ ...status(), accounts: [], error: err.message });
    }
  });

  // Money in and out of one account: ?from=YYYY-MM-DD&to=YYYY-MM-DD (the last 30 days if not given).
  router.get('/bank/:accountId/lines', requirePerm('bank.view'), async (req, res) => {
    if (!status().bank_access) throw badRequest('Atlas hasn’t been allowed to read your bank accounts in Xero yet – an admin can allow it under Setup → Xero');
    const accountId = String(req.params.accountId);
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw badRequest('Unknown bank account');
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -30);
    if (from > to) throw badRequest('The start date is after the end date');
    if (addDays(from, MAX_DAYS) < to) throw badRequest('Choose up to a year at a time');
    const accounts = await xero.bankAccounts(today());
    if (!accounts.some((a) => a.id === accountId)) throw badRequest('Unknown bank account');
    const lines = await xero.bankLines(accountId, from, to);
    const sum = (k) => Math.round(lines.reduce((t, l) => t + (l[k] ?? 0), 0) * 100) / 100;
    res.json({ from, to, lines, money_in: sum('amount_in'), money_out: sum('amount_out'), unreconciled: lines.filter((l) => !l.reconciled).length });
  });
}
