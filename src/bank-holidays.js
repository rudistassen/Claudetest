// Bank holidays in England and Wales, worked out for any year (no internet lookup needed), so sales forecasts can
// leave out days that don't behave like a normal day of the week.

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
const addDays = (s, n) => {
  const t = new Date(`${s}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// Easter Sunday (Gregorian), by the anonymous algorithm.
function easter(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

const firstMonday = (y, m) => { for (let d = 1; ; d++) if (dow(y, m, d) === 1) return iso(y, m, d); };
const lastMonday = (y, m) => { for (let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); ; d--) if (dow(y, m, d) === 1) return iso(y, m, d); };

// Years when a regular bank holiday moved, and one-off extra days.
const MOVED = { 2020: { 'Early May bank holiday': '2020-05-08' }, 2022: { 'Spring bank holiday': '2022-06-02' } };
const EXTRA = {
  2011: [['2011-04-29', 'Royal wedding']],
  2012: [['2012-06-05', 'Queen’s Diamond Jubilee']],
  2022: [['2022-06-03', 'Platinum Jubilee'], ['2022-09-19', 'State Funeral of Queen Elizabeth II']],
  2023: [['2023-05-08', 'Coronation of King Charles III']],
};

/** Map of 'YYYY-MM-DD' → name for the year's bank holidays in England and Wales. */
export function bankHolidays(y) {
  const out = new Map();
  // New Year's Day moves to Monday when it's a weekend.
  const ny = dow(y, 1, 1);
  out.set(ny === 6 ? iso(y, 1, 3) : ny === 0 ? iso(y, 1, 2) : iso(y, 1, 1), 'New Year’s Day');
  const e = easter(y);
  out.set(addDays(e, -2), 'Good Friday');
  out.set(addDays(e, 1), 'Easter Monday');
  const moved = MOVED[y] ?? {};
  out.set(moved['Early May bank holiday'] ?? firstMonday(y, 5), 'Early May bank holiday');
  out.set(moved['Spring bank holiday'] ?? lastMonday(y, 5), 'Spring bank holiday');
  out.set(lastMonday(y, 8), 'Summer bank holiday');
  // Christmas and Boxing Day: a weekend day moves to the next free weekday.
  const xmas = dow(y, 12, 25);
  if (xmas === 6) { out.set(iso(y, 12, 27), 'Christmas Day'); out.set(iso(y, 12, 28), 'Boxing Day'); }
  else if (xmas === 0) { out.set(iso(y, 12, 27), 'Christmas Day'); out.set(iso(y, 12, 26), 'Boxing Day'); }
  else if (xmas === 5) { out.set(iso(y, 12, 25), 'Christmas Day'); out.set(iso(y, 12, 28), 'Boxing Day'); }
  else { out.set(iso(y, 12, 25), 'Christmas Day'); out.set(iso(y, 12, 26), 'Boxing Day'); }
  for (const [d, name] of EXTRA[y] ?? []) out.set(d, name);
  return out;
}

const cache = new Map();
/** The bank holiday on a date ('YYYY-MM-DD'), or null. */
export function bankHoliday(date) {
  const y = Number(date.slice(0, 4));
  if (!cache.has(y)) cache.set(y, bankHolidays(y));
  return cache.get(y).get(date) ?? null;
}
