export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, message);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

const isBlank = (v) => v === undefined || v === null || v === '';

export function str(v, name, { required = false, max = 500 } = {}) {
  if (isBlank(v) || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return s;
}

export function num(v, name, { required = false, min, max, int = false } = {}) {
  if (isBlank(v)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (int && !Number.isInteger(n)) throw badRequest(`${name} must be a whole number`);
  if (min !== undefined && n < min) throw badRequest(`${name} must be at least ${min}`);
  if (max !== undefined && n > max) throw badRequest(`${name} must be at most ${max}`);
  return n;
}

export const id = (v, name, opts = {}) => num(v, name, { ...opts, int: true, min: 1 });

export function date(v, name, { required = false } = {}) {
  if (isBlank(v)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw badRequest(`${name} must be a date (YYYY-MM-DD)`);
  }
  return s;
}

export function time(v, name, { required = false } = {}) {
  if (isBlank(v)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const s = String(v);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw badRequest(`${name} must be a time (HH:MM)`);
  return s;
}

export function oneOf(v, name, allowed, { required = false } = {}) {
  if (isBlank(v)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (!allowed.includes(v)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

export const round2 = (n) => Math.round(n * 100) / 100;

// --- Dates (business days are in UK local time by default) ---

const TZ = process.env.TZ_BUSINESS || 'Europe/London';

export function today(tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing iso.
export function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -offset);
}

// Paid hours for a shift; an end time at or before the start is treated as finishing the next day.
export function shiftHours(start, end, breakMinutes = 0) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let mins = toMin(end) - toMin(start);
  if (mins <= 0) mins += 24 * 60;
  return Math.max(0, mins - (breakMinutes || 0)) / 60;
}

export function csv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return lines.join('\n') + '\n';
}

// Milliseconds the given time zone is ahead of UTC at the instant utcMs.
function tzOffsetMs(utcMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
}

/** UTC instant (ms) of a local date and "HH:MM" time in time zone tz. */
export function zonedTimeUTC(iso, hhmm, tz = TZ) {
  const guess = Date.parse(`${iso}T${hhmm}:00Z`);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

// UTC instant (RFC 3339) of local midnight at the start of iso in time zone tz.
export function zonedMidnightUTC(iso, tz = TZ) {
  const guess = Date.parse(`${iso}T00:00:00Z`);
  const first = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(first, tz)).toISOString();
}

// Local calendar date (YYYY-MM-DD) in tz of a UTC timestamp.
const dateFormats = new Map();

export function localDate(timestamp, tz = TZ) {
  if (!dateFormats.has(tz)) dateFormats.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return dateFormats.get(tz).format(new Date(timestamp));
}

const hourFormats = new Map();

// Local hour of the day (0–23) in tz of a UTC timestamp.
export function localHour(timestamp, tz = TZ) {
  if (!hourFormats.has(tz)) hourFormats.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }));
  return Number(hourFormats.get(tz).format(new Date(timestamp)));
}

export const BUSINESS_TZ = TZ;
