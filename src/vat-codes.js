// VAT codes for products: Xero's tax types, so each invoice line goes to Xero with the right VAT. When Xero is
// connected its own list is used (including any custom rates); otherwise these standard UK ones.

export const STANDARD_VAT_CODES = [
  { code: 'INPUT2', name: '20% (VAT on Expenses)', rate: 20 },
  { code: 'RRINPUT', name: '5% (VAT on Expenses)', rate: 5 },
  { code: 'ZERORATEDINPUT', name: 'Zero Rated Expenses', rate: 0 },
  { code: 'EXEMPTINPUT', name: 'Exempt Expenses', rate: 0 },
  { code: 'NONE', name: 'No VAT', rate: 0 },
];

/** The usual code for a VAT rate read off an invoice (20, 5 or 0), or null. */
export const vatCodeForRate = (rate) => ({ 20: 'INPUT2', 5: 'RRINPUT', 0: 'ZERORATEDINPUT' })[Number(rate)] ?? null;

/** A VAT code as given (Xero's codes are capitals and numbers, e.g. INPUT2 or TAX001), or null. */
export function cleanVatCode(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const code = String(v).trim().toUpperCase();
  return /^[A-Z0-9]{2,40}$/.test(code) ? code : undefined;
}
