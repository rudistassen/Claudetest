// A pretend Xero with two bank accounts, for the Bank tests (and trying the page out).
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export const MAIN = '11111111-1111-1111-1111-111111111111';
export const SAVINGS = '22222222-2222-2222-2222-222222222222';

export function fakeXeroBank({ calls = [], allowBank = () => true } = {}) {
  let n = 0;
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search });
    if (u.pathname === '/connect/token') { n++; return json(200, { access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 1800 }); }
    if (u.pathname === '/connections') return json(200, [{ tenantId: 'T1', tenantName: 'Brew & Barrel Ltd', tenantType: 'ORGANISATION' }]);
    const bankCall = /\/(BankTransactions|Payments|Reports\/BankSummary)$/.test(u.pathname);
    if (bankCall && !allowBank()) return json(403, { Title: 'Forbidden', Detail: 'AuthenticationUnsuccessful' });
    if (u.pathname === '/api.xro/2.0/Accounts') return json(200, { Accounts: [
      { AccountID: MAIN, Name: 'Business Current Account', Code: '090', Type: 'BANK', Status: 'ACTIVE', BankAccountNumber: '20-00-00 12345678', CurrencyCode: 'GBP' },
      { AccountID: SAVINGS, Name: 'Business Savings', Code: '091', Type: 'BANK', Status: 'ACTIVE', BankAccountNumber: '87654321', CurrencyCode: 'GBP' },
    ] });
    if (u.pathname === '/api.xro/2.0/Reports/BankSummary') return json(200, { Reports: [{ ReportID: 'BankSummary', Rows: [
      { RowType: 'Header', Cells: [{ Value: 'Bank Accounts' }, { Value: 'Opening Balance' }, { Value: 'Cash Received' }, { Value: 'Cash Spent' }, { Value: 'Closing Balance' }] },
      { RowType: 'Section', Rows: [
        { RowType: 'Row', Cells: [{ Value: 'Business Current Account', Attributes: [{ Value: MAIN, Id: 'accountID' }] }, { Value: '20000.00' }, { Value: '15850.40' }, { Value: '9120.15' }, { Value: '26730.25' }] },
        { RowType: 'Row', Cells: [{ Value: 'Business Savings', Attributes: [{ Value: SAVINGS, Id: 'accountID' }] }, { Value: '50000.00' }, { Value: '0.00' }, { Value: '0.00' }, { Value: '50000.00' }] },
        { RowType: 'SummaryRow', Cells: [{ Value: 'Total' }, { Value: '70000.00' }, { Value: '15850.40' }, { Value: '9120.15' }, { Value: '76730.25' }] },
      ] },
    ] }] });
    const d = (iso) => `${iso}T00:00:00`;
    const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    if (u.pathname === '/api.xro/2.0/BankTransactions') return json(200, { BankTransactions: u.searchParams.get('page') !== '1' ? [] : [
      { BankTransactionID: 'BT1', Type: 'RECEIVE', Status: 'AUTHORISED', DateString: d(day(1)), Total: 3120.4, IsReconciled: true, Reference: 'SQUARE PAYOUT', Contact: { Name: 'Square' }, LineItems: [{ Description: 'Card takings – High Street' }], BankAccount: { AccountID: MAIN } },
      { BankTransactionID: 'BT2', Type: 'SPEND', Status: 'AUTHORISED', DateString: d(day(2)), Total: 86.5, IsReconciled: false, Reference: 'DD', Contact: { Name: 'British Gas' }, LineItems: [{ Description: 'Gas – October' }], BankAccount: { AccountID: MAIN } },
      { BankTransactionID: 'BT3', Type: 'SPEND-TRANSFER', Status: 'AUTHORISED', DateString: d(day(3)), Total: 1000, IsReconciled: true, BankAccount: { AccountID: MAIN }, LineItems: [{ Description: 'To savings' }] },
      { BankTransactionID: 'BT4', Type: 'RECEIVE-TRANSFER', Status: 'AUTHORISED', DateString: d(day(3)), Total: 1000, IsReconciled: true, BankAccount: { AccountID: SAVINGS } },
      { BankTransactionID: 'BT5', Type: 'SPEND', Status: 'DELETED', DateString: d(day(4)), Total: 999, BankAccount: { AccountID: MAIN } },
      { BankTransactionID: 'BT6', Type: 'SPEND', Status: 'AUTHORISED', DateString: d(day(90)), Total: 50, BankAccount: { AccountID: MAIN } },
    ] });
    if (u.pathname === '/api.xro/2.0/Payments') return json(200, { Payments: u.searchParams.get('page') !== '1' ? [] : [
      { PaymentID: 'P1', PaymentType: 'ACCPAYPAYMENT', Status: 'AUTHORISED', Date: `/Date(${Date.parse(`${day(2)}T00:00:00Z`)}+0000)/`, Amount: 412.8, IsReconciled: true, Reference: 'INV-2231',
        Account: { AccountID: MAIN }, Invoice: { InvoiceID: 'I1', InvoiceNumber: 'INV-2231', Contact: { Name: 'Bidfood' } } },
      { PaymentID: 'P2', PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Date: `/Date(${Date.parse(`${day(5)}T00:00:00Z`)}+0000)/`, Amount: 650, IsReconciled: false,
        Account: { AccountID: MAIN }, Invoice: { InvoiceID: 'I2', InvoiceNumber: 'EV-104', Contact: { Name: 'Smith wedding' } } },
    ] });
    return json(404, { Message: 'Not found' });
  };
}
