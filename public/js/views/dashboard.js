import { attachTip, pairedBarChart } from '../charts.js';
import { addDays, api, chooseSite, esc, field, fmtDate, homeSite, input, isDemo, money, openModal, qs, siteColour, toast, todayISO } from '../lib.js';
import { clockInActions, wireClockInActions } from './breaks.js';
import { sickAttrs, wireSickButtons } from './sickness.js';
import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';

function progress(done, due) {
  const pct = due ? Math.round((done / due) * 100) : 100;
  const tone = pct === 100 ? 'good' : pct >= 50 ? 'warn' : 'bad';
  return `<div class="progress progress-${tone}" title="${done} of ${due}"><div style="width:${pct}%"></div></div>
    <div class="progress-label">${done} / ${due} done</div>`;
}

// "4h 05m" from hours.
// The day the dashboard is showing: today (so far, the default) or a whole earlier day picked from the date menu.
// isToday/day: the day shown; canSick: whether this person can mark a rota shift as sickness (rota editors).
const shown = { isToday: true, day: '', canSick: false, period: 'today' };
// What the figures are compared with, in words: "last week" / "last month" / "last year", and the longer form.
const cmpShort = () => shown.cmpShort ?? (shown.period === 'mtd' ? 'last month' : shown.period === 'ytd' ? 'last year' : 'last week');
const dayWord = () => (shown.isToday ? 'today' : fmtDate(shown.day, { weekday: 'short', day: 'numeric', month: 'short' }));

// Names on the dashboard are shortened to first name and last initial: "Boudebza Sid Ali" → "Boudebza A.".
// A note in brackets stays, e.g. "Indy (Manager)".
export function shortName(name) {
  const full = String(name ?? '').trim();
  const note = full.match(/\s*(\([^)]*\))\s*$/);
  const words = (note ? full.slice(0, note.index) : full).split(/\s+/).filter(Boolean);
  const short = words.length > 1 ? `${words[0]} ${words[words.length - 1][0].toUpperCase()}.` : words.join('');
  return note ? `${short} ${note[1]}` : short;
}

const duration = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

// Today so far against the same weekday last week up to the same time. Up is good for sales; labour is neutral.
function versus(now, then, { goodUp = true } = {}) {
  if (now === null || now === undefined) return `<span class="muted">No sales synced ${shown.isToday ? 'today' : 'for this day'}</span>`;
  if (!then) return `<span class="muted">${then === null ? 'Nothing to compare' : '£0'} ${cmpShort()}</span>`;
  const change = ((now - then) / then) * 100;
  const tone = !goodUp || Math.abs(change) < 0.5 ? '' : (change > 0) === goodUp ? 'tone-good' : 'tone-bad';
  return `<span class="${tone}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%</span><br><span class="muted">${money(then)} ${cmpShort()}</span>`;
}

// Clock-ins with the people in right now (including on a break) first, each group in the order they clocked in.
const inFirst = (list) => [...list].sort((a, b) => (a.end ? 1 : 0) - (b.end ? 1 : 0));

// "Who's in today": a table of everyone on today's rota, site by site, with when they clocked in and out and
// where they are now, then anyone clocked in without a shift.
export const ROSTER = {
  in: ['In', 'is-in'], on_break: ['On break', 'is-break'], done: ['Finished', 'is-done'], due: ['Due', 'is-due'],
  late: ['Not in', 'is-late'], missed: ['Didn’t clock in', 'is-late'], elsewhere: ['Elsewhere', 'is-other'],
  extra: ['Not on rota', 'is-other'], rota: ['On the rota', 'is-due'], sick: ['Sick', 'is-sick'],
};
function rosterRow(p) {
  const [label, tone] = ROSTER[p.status] ?? ['', ''];
  const note = p.status === 'late' ? `${mins(p.late_minutes)} late`
    : p.status === 'elsewhere' ? `at ${esc(p.where)}`
      : p.status === 'sick' ? (p.note ? esc(p.note) : '')
      : [p.rota_site ? 'covering' : '', p.late_minutes ? `${mins(p.late_minutes)} late` : ''].filter(Boolean).join(' · ');
  // Rota editors can tap someone on the rota to mark them as sick (or change it).
  const sickable = shown.canSick && p.shift_id && !p.rota_site && ['due', 'late', 'missed', 'rota', 'sick'].includes(p.status);
  return `<tr class="roster-row ${tone}">
    <td>${sickable ? `<button class="link-btn roster-sick" ${sickAttrs({ ...p, name: shortName(p.name), date: shown.day, sick: p.status === 'sick' })} title="${p.status === 'sick' ? 'Off sick – tap to change' : 'Tap to mark as sick'}">${esc(shortName(p.name))}</button>` : p.card_id ? cardLink(p.card_id, p.name) : esc(shortName(p.name))}</td>
    <td>${p.rota ? `${p.rota}${p.rota_site ? ` <span class="muted">at ${esc(p.rota_site)}</span>` : ''}` : '<span class="muted">–</span>'}</td>
    <td>${p.clock ? p.clock.replace('–now', '–<span class="muted">now</span>') : '<span class="muted">–</span>'}</td>
    <td><span class="roster-status">${label}</span>${note ? ` <span class="muted">${note}</span>` : ''}</td>
  </tr>`;
}
// When sales and clock-ins last came in from Square (every few minutes).
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const syncLine = (f) => `<span class="muted">${f.last_sync ? `Updated from Square at ${hm(`${f.last_sync.replace(' ', 'T')}Z`)}` : 'Not updated from Square yet'}</span>`;

function whosIn(locs, data, fresh) {
  const count = (list, ...st) => list.filter((p) => st.includes(p.status)).length;
  // Clocked in right now: in or on a break, or not on the rota and not clocked out yet.
  const inNow = (list) => list.filter((p) => p.status === 'in' || p.status === 'on_break' || (p.status === 'extra' && !p.clocked_out)).length;
  // On this site's rota (not covering from another site's rota, and not clocked in without a shift).
  const rotad = (list) => list.filter((p) => p.status !== 'extra' && !p.rota_site).length;
  const rows = locs.filter((l) => l.roster);
  const all = rows.flatMap((l) => l.roster);
  const notInAll = count(all, 'late', 'missed');
  // Folded away to just its heading (and each site to its own heading); tap to open.
  return `<details class="card whos-in">
    <summary class="card-head"><h2>${shown.isToday ? 'Who’s in today' : `Who was in · ${esc(dayWord())}`}</h2>
      ${shown.isToday && fresh?.connected ? `<span class="sync-line small">${syncLine(fresh)}</span>` : ''}
      <span class="muted small">${rotad(all)} on the rota · ${shown.isToday ? `${inNow(all)} clocked in now` : `${all.filter((p) => p.clock).length} clocked in`}${notInAll ? ` · <span class="tone-bad">${notInAll} not in</span>` : ''}</span></summary>
    <div class="whos-in-grid">${rows.map((l) => {
      const r = l.roster;
      const notIn = count(r, 'late', 'missed');
      return `<details class="whos-in-site" style="--site: ${siteColour(l.name, l.id)}">
        <summary class="whos-in-site-head"><strong>${esc(l.name)}</strong>
          <span class="muted">${rotad(r)} rota’d · ${shown.isToday ? `${inNow(r)} in` : `${r.filter((p) => p.clock).length} clocked in`}${notIn ? ` · <span class="tone-bad">${notIn} not in</span>` : ''}</span></summary>
        ${r.length ? `<table class="whos-in-table"><thead><tr><th>Person</th><th>Rota</th><th>Clocked</th><th>Status</th></tr></thead>
          <tbody>${r.map(rosterRow).join('')}</tbody></table>` : `<p class="muted small">Nobody on the rota ${dayWord()}</p>`}
      </details>`;
    }).join('')}</div>
    ${data.labour_synced ? '' : '<p class="muted small">Clock-ins come from Square once it’s connected; until then this shows the rota only.</p>'}
  </details>`;
}

// The change on last week, as a small ▲/▼ percentage (green up, red down).
function change(now, then) {
  if (!then) return '';
  const c = ((now - then) / then) * 100;
  const tone = Math.abs(c) < 0.5 ? 'muted' : c > 0 ? 'tone-good' : 'tone-bad';
  return `<span class="dash-vs ${tone}" title="${money(then)} ${cmpShort()}">${Math.abs(c) < 0.05 ? '■ 0.0%' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}%`}</span>`;
}

// "incl. £312.40 in 9 open orders": tabs and tickets not paid yet, counted in today's sales until they're paid.
function openNote(locs) {
  if (!shown.isToday) return '';
  const n = locs.reduce((t, l) => t + (l.open_orders ?? 0), 0);
  if (!n) return '';
  const amount = locs.reduce((t, l) => t + (l.open_gross ?? 0), 0);
  return `<span class="muted kpi-open" title="Tabs and tickets not paid yet – included until they're paid">incl. ${money(amount)} in ${n} open order${n === 1 ? '' : 's'}</span>`;
}

// For the labour tile: the change in percentage points on last week by this time. Lower labour is good (green).
function labourVersus(now, then) {
  if (now === null || now === undefined) return '<span class="muted">of net sales so far</span>';
  if (then === null || then === undefined) return `<span class="muted">of net sales · nothing to compare ${cmpShort()}</span>`;
  const d = Math.round((now - then) * 10) / 10;
  const tone = Math.abs(d) < 0.5 ? 'muted' : d > 0 ? 'tone-bad' : 'tone-good';
  return `<span class="${tone}">${d === 0 ? '■ 0.0 pts' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts`}</span> <span class="muted">on ${cmpShort()}</span>`;
}

// For a tile: "▲ 4.2% on last week".
function versusLine(now, then) {
  if (now === null) return `<span class="muted">No sales synced ${shown.isToday ? 'yet today' : 'for this day'}</span>`;
  if (!then) return `<span class="muted">Nothing to compare ${cmpShort()}</span>`;
  const change = ((now - then) / then) * 100;
  const tone = Math.abs(change) < 0.5 ? 'muted' : change > 0 ? 'tone-good' : 'tone-bad';
  return `<span class="${tone}">${Math.abs(change) < 0.05 ? '■ 0.0%' : `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%`}</span> <span class="muted">on ${cmpShort()}</span>`;
}

const siteInitials = (name) => name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);


// A name that opens their timecard for the day.
const cardLink = (id, name) => `<button type="button" class="link-btn card-link" data-timecard="${esc(id)}" title="See ${esc(shortName(name))}’s timecard"><strong>${esc(shortName(name))}</strong></button>`;

// One clock-in in full: their rota, when they clocked in and out, each break, and the hours it comes to.
function timecardBody(c, loc) {
  const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const breaks = c.breaks?.length
    ? `<ul class="tc-breaks">${c.breaks.map((b) => `<li>${b.start}–${b.end ?? '<span class="muted">now</span>'} · ${mins(b.minutes)} · ${b.paid ? 'paid' : 'unpaid'}${b.name ? ` <span class="muted">(${esc(b.name)})</span>` : ''}</li>`).join('')}</ul>`
    : c.breaks_known === false && c.unpaid_break_minutes ? `${mins(c.unpaid_break_minutes)} unpaid <span class="muted">(times not recorded)</span>`
      : '<span class="muted">No breaks</span>';
  return `<p class="muted">${esc(loc.name)} · ${fmtDate(shown.day, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    <dl class="tc-details">
      ${row('Rota', c.rota ?? (c.not_on_rota ? '<span class="tone-warn">Not on the rota</span>' : '<span class="muted">–</span>'))}
      ${row('Clocked in', `${c.start}${c.late_minutes ? ` <span class="mini-tag is-warn">${mins(c.late_minutes)} late</span>` : ''}`)}
      ${row('Clocked out', `${c.end ?? `<span class="muted">Still in${c.on_break ? ' – on a break' : ''}</span>`}${c.over_minutes ? ` <span class="mini-tag is-warn">+${mins(c.over_minutes)} after shift</span>` : ''}`)}
      ${row('Breaks', breaks)}
      ${c.paid_break_minutes || c.unpaid_break_minutes ? row('Break time', [c.unpaid_break_minutes ? `${mins(c.unpaid_break_minutes)} unpaid` : '', c.paid_break_minutes ? `${mins(c.paid_break_minutes)} paid` : ''].filter(Boolean).join(' · ')) : ''}
      ${row(c.end ? 'Hours worked' : 'Hours so far', `<strong>${duration(c.hours)}</strong> <span class="muted">(unpaid breaks taken off)</span>`)}
    </dl>
    ${c.break_flag ? `<p class="notice tone-bad">⚠ Worked over 6 hours ${c.break_flag === 'none' ? 'without a break' : 'without a 20-minute break'}.</p>` : ''}`;
}

// One-line version for the site cards: short tags, with the details (rota, breaks) on hover.
function clockTags(c) {
  const tags = [];
  if (c.late_minutes) tags.push(`<span class="mini-tag is-warn" title="Late in ${mins(c.late_minutes)}">Late ${mins(c.late_minutes)}</span>`);
  if (c.over_minutes) tags.push(`<span class="mini-tag is-warn" title="${c.end ? 'Clocked out' : 'Still in'} ${mins(c.over_minutes)} after shift">+${mins(c.over_minutes)}</span>`);
  if (c.not_on_rota) tags.push('<span class="mini-tag" title="Not on the rota">No rota</span>');
  if (c.break_flag) tags.push(`<span class="mini-tag is-bad" title="Worked over 6 hours without a 20-minute break">⚠ ${c.break_flag === 'none' ? 'No break' : 'Short break'}</span>`);
  return tags.length ? ` ${tags.join(' ')}` : '';
}
const clockTitle = (c) => [
  c.rota ? `Rota ${c.rota}` : c.not_on_rota ? 'Not on the rota' : '',
  c.breaks?.length ? `Break ${c.breaks.map((b) => `${b.start}–${b.end ?? 'now'}`).join(', ')}` : '',
].filter(Boolean).join(' · ');

function card(loc, state, data, slice = null) {
  const staff = loc.shifts_today;
  const lw = loc.last_week;
  // Over a period (week / month / year to date) the money and checks are for the period; who's in stays the day.
  const per = loc.period ?? null;
  const g = slice ? { now: slice.gross, then: slice.grossThen, cost: slice.cost, costThen: slice.costThen, pct: slice.labourPct, rota: slice.basis === 'rota' }
    : { now: loc.gross_today, then: lw.gross, cost: loc.labour_cost_today, costThen: lw.labour_cost, pct: loc.labour_pct_today, rota: loc.labour_basis === 'rostered' };
  const clocked = loc.clock_ins && data.labour_synced;
  return `
    <section class="card site-card" style="--site: ${siteColour(loc.name, loc.id)}">
      <header class="card-head">
        <h2 data-initials="${esc(siteInitials(loc.name))}">${esc(loc.name)}</h2>
        ${state.multiSite ? `<button class="btn btn-small" data-open="${loc.id}">Open site</button>` : ''}
      </header>
      ${state.can('sales.view') ? `
      <div class="site-money">
        <div>
          <h3>Gross sales</h3>
          <p class="stat">${g.now === null ? '<span class="muted">–</span>' : money(g.now)}</p>
          <p class="small">${versus(g.now, g.then)}</p>
          ${!slice && shown.isToday && loc.open_orders ? `<p class="small muted">incl. ${money(loc.open_gross)} open (${loc.open_orders})</p>` : ''}
        </div>
        <div>
          <h3>Labour cost</h3>
          <p class="stat">${money(g.cost)}</p>
          <p class="small">${versus(g.cost, g.costThen, { goodUp: false })}</p>
          <p class="small tone-${labourTone(g.pct)}">${fmtPct(g.pct)} of net sales${g.rota ? ' (rota)' : ''}</p>
        </div>
      </div>
      <p class="small muted site-compare">${slice ? `${PL(shown.period)} vs ${CN(shown.period)}` : `${shown.isToday ? 'Today so far' : 'The whole day'} vs ${fmtDate(data.compare_date, { weekday: 'short', day: 'numeric', month: 'short' })}${shown.isToday ? ' at the same time' : ''}`}</p>` : ''}
      <div class="site-grid">
        ${clocked ? `
        <div class="span-2">
          <h3>Clocked in ${dayWord()} (${loc.clock_ins.length})</h3>
          ${loc.clock_ins.length
            ? `<ul class="clock-rows">${inFirst(loc.clock_ins).map((c) => `<li class="clock-row ${c.end ? '' : 'is-in'}" title="${esc(clockTitle(c))}">
                <span class="cr-main">${cardLink(c.id, c.name)} <span class="muted">${c.start}–${c.end ?? 'now'}</span></span>${clockTags(c) ? `<span class="cr-tags">${clockTags(c)}</span>` : ''}
                <span class="cr-hours">${!c.end && c.on_break ? '<span class="badge badge-on-break">Break</span> ' : ''}${duration(c.hours)}</span>
                ${clockInActions(state, c, loc.id, { compact: true })}</li>`).join('')}</ul>
              <p class="small muted">${duration(loc.clock_ins.reduce((n, c) => n + c.hours, 0))} in total</p>`
            : '<p class="muted">Nobody has clocked in yet</p>'}
          ${loc.not_clocked_in?.length ? `<ul class="clock-rows clock-missing">${loc.not_clocked_in.map((m) => `<li class="clock-row">
              <span class="cr-main"><strong>${esc(shortName(m.name))}</strong> <span class="muted">rota ${m.rota}</span></span>
              <span class="cr-hours"><span class="mini-tag is-bad">${m.shift_over ? 'Didn’t clock in' : `Not in · ${mins(m.late_minutes)} late`}</span>
                ${shown.canSick && m.shift_id ? `<button class="mini-tag sick-btn" ${sickAttrs({ ...m, name: shortName(m.name), date: shown.day })} title="Mark as sick">Sick?</button>` : ''}</span></li>`).join('')}</ul>` : ''}
          ${loc.sick?.length ? `<ul class="clock-rows clock-sick">${loc.sick.map((m) => `<li class="clock-row">
              <span class="cr-main"><strong>${esc(shortName(m.name))}</strong> <span class="muted">rota ${m.rota}${m.note ? ` · ${esc(m.note)}` : ''}</span></span>
              <span class="cr-hours">${shown.canSick ? `<button class="mini-tag is-sick" ${sickAttrs({ ...m, name: shortName(m.name), date: shown.day, sick: true })} title="Off sick – tap to change">Sick</button>` : '<span class="mini-tag is-sick">Sick</span>'}</span></li>`).join('')}</ul>` : ''}
        </div>` : `
        <div class="span-2">
          <h3>On shift ${dayWord()} (${staff.length})</h3>
          ${staff.length
            ? `<ul class="shift-list">${staff.map((s) => `<li><strong>${esc(shortName(s.name))}</strong> ${s.start_time}–${s.end_time}${shown.canSick ? ` <button class="mini-tag ${s.sick ? 'is-sick' : 'sick-btn'}" ${sickAttrs({ shift_id: s.id, name: shortName(s.name), rota: `${s.start_time}–${s.end_time}`, date: shown.day, sick: !!s.sick })}>${s.sick ? 'Sick' : 'Sick?'}</button>` : s.sick ? ' <span class="mini-tag is-sick">Sick</span>' : ''}</li>`).join('')}</ul>`
            : '<p class="muted">Nobody rostered</p>'}
        </div>`}
        <div class="site-checks span-2">
          <h3>Daily compliance checks${per ? ` · ${PL(shown.period).toLowerCase()}` : ''}</h3>
          ${per ? progress(per.daily.done, per.daily.due) : progress(loc.daily.done, loc.daily.due)}
          ${(per ? per.daily.fails : loc.daily.fails) ? `<p class="alert-text">⚠ ${per ? per.daily.fails : loc.daily.fails} failed check(s) ${per ? PL(shown.period).toLowerCase() : dayWord()}</p>` : ''}
          ${per ? `<p class="small muted">Wastage ${PL(shown.period).toLowerCase()}: ${money(per.wastage)}</p>` : ''}
        </div>
      </div>
    </section>`;
}

// "Download PDF": the browser's print window, set up for a landscape A4 page, with the file named after the
// dashboard and date. Choosing "Save as PDF" as the printer saves it.
function downloadPdf(state, date) {
  const title = document.title;
  const page = document.createElement('style');
  page.textContent = '@page { size: A4 landscape; margin: 10mm; }';
  document.head.append(page);
  document.title = `Atlas dashboard - ${state.multiSite ? 'All sites' : state.location?.name ?? ''} - ${date}`;
  const restore = () => {
    document.title = title;
    page.remove();
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  toast('Choose “Save as PDF” as the printer, then Save');
  setTimeout(() => window.print(), 50);
}

// Sales and labour % for each site, today or over the last 7 days (the same figures as the Trading page).
// The by-site panel's periods. Each runs up to the day shown (today, or a day picked), and is compared with the same
// span before it: the same time last week (today, 7 days, week to date – with today up to this time), or the same
// dates last month / last year (month and year to date – whole days).
export const PERIODS = ['today', 'week', 'wtd', 'mtd', 'ytd'];
export const PERIOD_LABEL = { today: 'Today', week: 'Last 7 days', wtd: 'Week to date', mtd: 'Month to date', ytd: 'Year to date' };
const PRINT_LABEL = { week: '7 days', wtd: 'week to date', mtd: 'month to date', ytd: 'year to date' };
export const COMPARE_NOTE = { today: 'the same time last week', week: 'the same time last week', wtd: 'the same time last week', mtd: 'the same dates last month', ytd: 'the same dates last year' };
// The timeframe's own name (This week, 6 – 12 Oct, September 2026…) and what it's compared with, when one is picked.
const PL = (p) => shown.label ?? PERIOD_LABEL[p] ?? '';
const CN = (p) => shown.compare ?? COMPARE_NOTE[p] ?? '';
const pad = (n) => String(n).padStart(2, '0');
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1–12
/** The dates a period covers up to d (YYYY-MM-DD), and the span it's compared with (null when nothing to fetch). */
export function periodRange(period, d) {
  const [y, m, day] = d.split('-').map(Number);
  if (period === 'week') return { from: addDays(d, -6), to: d, prevFrom: addDays(d, -13), prevTo: addDays(d, -8) };
  if (period === 'wtd') {
    const monday = addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
    // Last week's Monday up to the day before last week's matching day (that day itself, to this time, comes from /dashboard).
    return { from: monday, to: d, prevFrom: addDays(monday, -7), prevTo: monday === d ? null : addDays(d, -8) };
  }
  if (period === 'mtd') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: `${y}-${pad(m)}-01`, to: d, prevFrom: `${py}-${pad(pm)}-01`, prevTo: `${py}-${pad(pm)}-${pad(Math.min(day, lastDayOf(py, pm)))}` };
  }
  if (period === 'ytd') return { from: `${y}-01-01`, to: d, prevFrom: `${y - 1}-01-01`, prevTo: `${y - 1}-${pad(m)}-${pad(Math.min(day, lastDayOf(y - 1, m)))}` };
  return { from: d, to: d, prevFrom: null, prevTo: null };
}
// --- The timeframe: a day, a week (Monday–Sunday), a month, a year, or custom dates ---
const TF_KEY = 'cafe-ops:dashboard-timeframe';
export const TIMEFRAMES = ['day', 'week', 'month', 'year', 'custom'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const mondayOf = (d) => addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
const ymd = (d) => d.split('-').map(Number);
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const short = (d, today) => fmtDate(d, { day: 'numeric', month: 'short', ...(d.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });

/**
 * What a timeframe covers: { tf, from, to (the last day shown – never after today), period (how the figures are
 * worked out, see periodRange), range, title and sub (for the selector), name and compare (for the figures), atEnd }.
 */
export function timeframe(tf, query, today) {
  const anchor = ISO.test(query.date ?? '') && query.date < today ? query.date : today;
  const cap = (d) => (d > today ? today : d);
  let from;
  let end;
  if (tf === 'week') { from = mondayOf(anchor); end = addDays(from, 6); }
  else if (tf === 'month') { const [y, m] = ymd(anchor); from = `${y}-${pad(m)}-01`; end = `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`; }
  else if (tf === 'year') { from = `${anchor.slice(0, 4)}-01-01`; end = `${anchor.slice(0, 4)}-12-31`; }
  else if (tf === 'custom') {
    from = ISO.test(query.from ?? '') ? query.from : addDays(anchor, -6);
    end = anchor;
    if (from > end) [from, end] = [end, from];
  } else { from = anchor; end = anchor; }
  const to = cap(end);
  const live = end >= today;
  const t = { tf, from, to, end, atEnd: live, period: { day: 'today', week: 'wtd', month: 'mtd', year: 'ytd', custom: 'custom' }[tf] ?? 'today' };
  if (tf === 'custom') {
    const n = days(from, to) + 1;
    t.range = { from, to, prevFrom: addDays(from, -n), prevTo: addDays(from, -1) };
  } else {
    t.range = periodRange(t.period, to);
  }
  const lastWeek = addDays(mondayOf(today), -7);
  if (tf === 'day') {
    t.title = anchor === today ? 'Today' : anchor === addDays(today, -1) ? 'Yesterday' : fmtDate(anchor, { weekday: 'short', day: 'numeric', month: 'short', ...(anchor.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
    t.sub = anchor === today ? 'so far' : '';
    Object.assign(t, { name: null, compare: null, cmpShort: null, cmpLong: null, prevLabel: 'The day before', nextLabel: 'The next day' });
  } else if (tf === 'week') {
    t.title = live ? 'This week' : from === lastWeek ? 'Last week' : `Week of ${short(from, today)}`;
    t.sub = `${short(from, today)} – ${short(end, today)}`;
    Object.assign(t, { name: live ? 'This week' : t.title === 'Last week' ? 'Last week' : `w/c ${short(from, today)}`, compare: live ? 'the same time last week' : 'the week before',
      cmpShort: live ? 'last week' : 'the week before', cmpLong: live ? 'over the same time last week' : 'over the week before', prevLabel: 'The week before', nextLabel: 'The next week' });
  } else if (tf === 'month') {
    const month = fmtDate(from, { month: 'long', year: 'numeric' });
    t.title = live ? 'This month' : month;
    t.sub = live ? month : '';
    Object.assign(t, { name: live ? 'This month' : month, compare: live ? 'the same dates last month' : 'the month before', cmpShort: live ? 'last month' : 'the month before',
      cmpLong: live ? 'over the same dates last month' : 'over the month before', prevLabel: 'The month before', nextLabel: 'The next month' });
  } else if (tf === 'year') {
    t.title = live ? 'This year' : from.slice(0, 4);
    t.sub = live ? from.slice(0, 4) : '';
    Object.assign(t, { name: live ? 'This year' : from.slice(0, 4), compare: live ? 'the same dates last year' : 'the year before', cmpShort: live ? 'last year' : 'the year before',
      cmpLong: live ? 'over the same dates last year' : 'over the year before', prevLabel: 'The year before', nextLabel: 'The next year' });
  } else {
    t.title = `${short(from, today)} – ${short(to, today)}`;
    t.sub = `${days(from, to) + 1} days`;
    Object.assign(t, { name: t.title, compare: 'the same number of days before', cmpShort: 'the days before', cmpLong: 'over the same number of days before',
      prevLabel: 'The same number of days before', nextLabel: 'The same number of days after' });
  }
  return t;
}

/** The timeframe one step back (-1) or forward (1): a day, week, month or year, or custom dates moved by their length. */
export function stepTimeframe(t, dir, today) {
  if (t.tf === 'custom') {
    const n = (days(t.from, t.to) + 1) * dir;
    const from = addDays(t.from, n);
    return { tf: 'custom', from, to: addDays(t.to, n) > today ? today : addDays(t.to, n) };
  }
  let anchor;
  if (t.tf === 'week') anchor = addDays(t.from, 7 * dir);
  else if (t.tf === 'month') { const [y, m] = ymd(t.from); const nm = m + dir; const yy = y + Math.floor((nm - 1) / 12); const mm = ((nm - 1) % 12 + 12) % 12 + 1; anchor = `${yy}-${pad(mm)}-01`; }
  else if (t.tf === 'year') anchor = `${Number(t.from.slice(0, 4)) + dir}-01-01`;
  else anchor = addDays(t.from, dir);
  const next = timeframe(t.tf, { date: anchor }, today);
  return next;
}
/** The timeframe selector: ‹ This week · 13 – 19 Oct ›, and a note under it (HTML). */
export function timeframeBar(t, note = '') {
  return `<div class="tf-bar">
      <div class="tf-pick" role="group" aria-label="Timeframe">
        <button type="button" class="tf-arrow" data-tf-step="-1" aria-label="${esc(t.prevLabel)}" title="${esc(t.prevLabel)}">‹</button>
        <button type="button" class="tf-label" id="tf-open" aria-haspopup="dialog" title="Choose the timeframe"><strong>${esc(t.title)}</strong>${t.sub ? `<span> · ${esc(t.sub)}</span>` : ''}</button>
        <button type="button" class="tf-arrow" data-tf-step="1" aria-label="${esc(t.nextLabel)}" title="${esc(t.nextLabel)}" ${t.atEnd ? 'disabled' : ''}>›</button>
      </div>
      ${note ? `<p class="muted small dash-period-note">${note}</p>` : ''}
    </div>`;
}

/**
 * Wires the selector: the arrows step back and forward by the timeframe; the middle opens the choice of timeframe.
 * page is where it goes (with keep: other query values to keep, e.g. the site); key remembers the choice.
 */
export function wireTimeframe(el, { t, tf, today, navigate, page, key, keep = {} }) {
  const goTo = (next) => {
    try { if (next.tf !== 'custom') localStorage.setItem(key, next.tf); } catch { /* storage unavailable */ }
    const live = next.to >= today && next.tf !== 'custom';
    navigate(`${page}${qs({ ...keep, tf: next.tf === 'day' && live ? undefined : next.tf, date: live ? undefined : next.to, from: next.tf === 'custom' ? next.from : undefined })}`);
  };
  el.querySelectorAll('[data-tf-step]').forEach((b) => b.addEventListener('click', () => goTo(stepTimeframe(t, Number(b.dataset.tfStep), today))));
  el.querySelector('#tf-open').addEventListener('click', () => {
    const { form } = openModal({
      title: 'Timeframe',
      submitLabel: 'Done',
      body: `<div class="tf-options">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom dates']].map(([k, l]) => `<label class="tf-option">
          <span>${l}</span><input type="radio" name="tf" value="${k}" ${tf === k ? 'checked' : ''}></label>`).join('')}</div>
        <div class="tf-custom" ${tf === 'custom' ? '' : 'hidden'}>
          <div class="row">${field('From', input('from', t.range.from, `type="date" max="${today}"`))}${field('To', input('to', t.range.to, `type="date" max="${today}"`))}</div>
          <p class="muted small">Up to a year. Compared with the same number of days just before.</p>
        </div>
        <p class="muted small">Week runs Monday to Sunday. The arrows step back and forward a whole day, week, month or year.</p>`,
      onSubmit: async (v, f) => {
        const choice = f.tf.value;
        if (choice === 'custom') {
          if (!v.from || !v.to) throw new Error('Choose both dates');
          const [from, to] = v.from <= v.to ? [v.from, v.to] : [v.to, v.from];
          if ((Date.parse(to) - Date.parse(from)) / 86400000 > 365) throw new Error('Choose up to a year');
          goTo({ tf: 'custom', from, to: to > today ? today : to });
          return;
        }
        // Switching timeframe keeps the day you're on (so a week picked from a day is that day's week).
        goTo(timeframe(choice, { date: t.to }, today));
      },
    });
    form.querySelectorAll('[name=tf]').forEach((r) => r.addEventListener('change', () => { form.querySelector('.tf-custom').hidden = form.tf.value !== 'custom'; }));
  });
}

/** Which timeframe to show: ?tf=, else the one remembered (not custom dates), else a day. */
export function chosenTimeframe(query, key, fallback = 'day') {
  if (TIMEFRAMES.includes(query.tf)) return query.tf;
  try { const saved = localStorage.getItem(key); if (TIMEFRAMES.includes(saved) && saved !== 'custom') return saved; } catch { /* storage unavailable */ }
  return fallback;
}
const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;

function bySite(t, period, prev, state) {
  const labour = (r) => (t.labour_synced && r.labour_pct !== null ? r.labour_pct : r.rostered_labour_pct);
  const rows = [...t.locations].sort((a, b) => b.gross_sales - a.gross_sales);
  const maxSales = Math.max(1, ...rows.map((r) => Math.max(r.gross_sales, prev.get(r.id) ?? 0)));
  const prevTotal = rows.some((r) => prev.get(r.id) !== null && prev.get(r.id) !== undefined) ? rows.reduce((n, r) => n + (prev.get(r.id) ?? 0), 0) : null;
  const icon = (p) => (p === null || p === undefined ? '' : labourTone(p) === 'good' ? '✓ ' : '⚠ ');
  // One line a site: gross sales and the change, orders, and labour % (coloured against the target), with a thin
  // bar underneath – its sales (site colour) over the period it's compared with (grey).
  const line = (r, name, then, { total = false } = {}) => `<div class="bs-row ${total ? 'bs-total' : ''}" ${total ? '' : `data-site-row="${r.id}" tabindex="0" style="--site: ${siteColour(r.name, r.id)}"`}>
      <span class="bs-name">${total ? '' : '<i class="bs-dot" aria-hidden="true"></i>'}${esc(name)}${!total && !r.linked ? ' <small class="muted">not on Square</small>' : ''}</span>
      <span class="bs-sales"><strong>${money(r.gross_sales)}</strong> ${change(r.gross_sales, then)}</span>
      <span class="bs-orders">${r.orders}<small> orders</small></span>
      <span class="bs-labour tone-${labourTone(labour(r))}">${icon(labour(r))}${fmtPct(labour(r))}</span>
      ${total ? '' : `<span class="bs-bar" aria-hidden="true"><i style="width:${(r.gross_sales / maxSales) * 100}%"></i>${then !== null && then !== undefined ? `<i class="bs-prev" style="width:${(then / maxSales) * 100}%"></i>` : ''}</span>`}
    </div>`;
  return `
    <section class="card dash-sites">
      <header class="card-head">
        <h2>Sales &amp; labour by site<span class="print-only"> · ${(period === 'today' ? dayWord() : PL(period).toLowerCase())}</span></h2>
        <span class="muted small">${PL(period) === 'Today' ? (shown.isToday ? 'Today' : dayWord()) : PL(period)}</span>
      </header>
      <div class="bs-list">
        <div class="bs-row bs-head"><span class="bs-name">Site</span><span class="bs-sales">Gross sales</span><span class="bs-orders">Orders</span><span class="bs-labour">Labour</span><span class="bs-bar-head"></span></div>
        ${rows.map((r) => line(r, r.name, prev.get(r.id))).join('')}
        ${rows.length > 1 ? line(t.totals, 'All sites', prevTotal, { total: true }) : ''}
      </div>
      <p class="muted small bs-note">${period === 'today' ? (shown.isToday ? 'So far today' : `All of ${dayWord()}`) : `${fmtDate(t.from, { day: 'numeric', month: 'short' })} – ${fmtDate(t.to, { day: 'numeric', month: 'short' })}`} · grey bar: ${CN(period)} · labour % of net sales (${t.labour_synced ? 'clocked' : 'rostered'}), target ${LABOUR_TARGET}%.${state.can('reports.trading') ? ' <a href="#/trading">Trading →</a>' : ''}</p>
    </section>`;
}

export async function render({ el, state, navigate, stale, rerender, query = {} }) {
  const seeSales = state.can('sales.view');
  const today = todayISO();
  // One timeframe – a day, a Monday–Sunday week, a month, a year, or dates picked – stepped back and forward with
  // the arrows. A week, month or year still going runs up to today. Remembered in this browser (not custom dates).
  const tf = chosenTimeframe(query, TF_KEY);
  const t = timeframe(tf, query, today);
  const d0 = t.to;
  const period = t.period;
  shown.isToday = d0 === today;
  shown.day = d0;
  shown.canSick = state.can('rota.edit');
  shown.period = period;
  Object.assign(shown, { label: t.name, compare: t.compare, cmpShort: t.cmpShort, cmpLong: t.cmpLong });
  const ranged = period !== 'today';
  const range = t.range;
  // The chart goes by month over a year (or long custom dates), otherwise by day.
  const byMonth = period === 'ytd' || (period === 'custom' && days(range.from, range.to) > 62);
  const [data, leave, security, fresh, tradeToday, tradeRange, tradePrev] = await Promise.all([
    api(`/dashboard${qs({ date: shown.isToday ? undefined : d0, from: ranged ? range.from : undefined })}`),
    state.can('leave.manage') ? api('/leave/pending-count') : { count: 0 },
    state.isAdmin && !isDemo ? api('/admin/security').catch(() => null) : null,
    seeSales || state.can('staff.manage') ? api('/square/freshness').catch(() => null) : null,
    seeSales ? api(`/trading?from=${d0}&to=${d0}`) : null,
    seeSales && period !== 'today' ? api(`/trading?from=${range.from}&to=${range.to}`) : null,
    // What it's compared with (see periodRange).
    seeSales && range.prevTo ? api(`/trading?from=${range.prevFrom}&to=${range.prevTo}`) : null,
  ]);
  if (stale()) return;
  const trade = period === 'today' ? tradeToday : tradeRange;

  const locs = data.locations;
  const totals = locs.reduce((t, l) => ({
    dailyDone: t.dailyDone + l.daily.done,
    dailyDue: t.dailyDue + l.daily.due,
    fails: t.fails + l.daily.fails,
    staff: t.staff + l.shifts_today.length,
    sales: t.sales + (l.sales_today ?? 0),
    labour: t.labour + (l.labour_cost_today ?? 0),
  }), { dailyDone: 0, dailyDue: 0, fails: 0, staff: 0, sales: 0, labour: 0 });
  // Today's sales and labour % for the whole group, matching the by-site panel and the Trading page.
  const hasSales = !!tradeToday && tradeToday.square_connected;
  const todayTotals = tradeToday?.totals;
  // Everyone clocked in right now across the sites (from Square), or null when clock-ins aren't available.
  // (On an earlier day: everyone who clocked in that day.)
  const inNow = (c) => !shown.isToday || !c.end;
  const clockedInNow = data.labour_synced && locs.some((l) => l.clock_ins)
    ? locs.reduce((n, l) => n + (l.clock_ins ?? []).filter(inNow).length, 0) : null;
  // Gross sales so far today against the same weekday last week up to the same time.
  const withGross = locs.filter((l) => l.gross_today !== null);
  const gross = {
    now: withGross.length ? withGross.reduce((n, l) => n + l.gross_today, 0) : null,
    then: locs.some((l) => (l.last_week?.gross ?? null) !== null) ? locs.reduce((n, l) => n + (l.last_week?.gross ?? 0), 0) : null,
  };
  // Each site's gross sales over the same period last week, up to the same time of day.
  const prevSales = new Map(locs.map((l) => {
    const sameTime = l.last_week?.gross ?? null;
    if (period === 'today') return [l.id, sameTime];
    const before = tradePrev?.locations.find((x) => x.id === l.id)?.gross_sales ?? 0;
    // Month and year to date are compared with whole days last month / last year.
    if (period === 'mtd' || period === 'ytd' || period === 'custom') return [l.id, before || null];
    return [l.id, sameTime === null && !before ? null : before + (sameTime ?? 0)];
  }));
  // Labour % by this time on the same day last week, worked out the same way (labour cost ÷ net sales, only
  // counting sites that had both).
  const lwSites = locs.filter((l) => l.last_week?.net > 0 && l.last_week?.labour_cost > 0);
  const lwNet = lwSites.reduce((n, l) => n + l.last_week.net, 0);
  const labourLastWeek = lwNet ? Math.round((lwSites.reduce((n, l) => n + l.last_week.labour_cost, 0) / lwNet) * 1000) / 10 : null;
  let labourPct = todayTotals ? (tradeToday.labour_synced && todayTotals.labour_pct !== null ? todayTotals.labour_pct : todayTotals.rostered_labour_pct) : null;
  // Over a period (week / month / year to date): the same tiles for the whole period, against the span it's
  // compared with (see periodRange). Week-type periods add last week's matching day up to this time.
  const sameTimeToo = period === 'week' || period === 'wtd';
  const costOf = (x, synced) => (x ? (synced ? x.clocked_cost : x.rostered_cost) : 0);
  let labourThen = labourLastWeek;
  if (ranged) {
    const t = tradeRange?.totals;
    gross.now = t ? t.gross_sales : null;
    gross.then = [...prevSales.values()].some((v) => v !== null && v !== undefined) ? [...prevSales.values()].reduce((n, v) => n + (v ?? 0), 0) : null;
    labourPct = t ? (tradeRange.labour_synced && t.labour_pct !== null ? t.labour_pct : t.rostered_labour_pct) : null;
    const pt = tradePrev?.totals;
    const synced = !!tradeRange?.labour_synced;
    const prevNet = (pt?.net_sales ?? 0) + (sameTimeToo ? locs.reduce((n, l) => n + (l.last_week?.net ?? 0), 0) : 0);
    const prevCost = costOf(pt, synced) + (sameTimeToo ? locs.reduce((n, l) => n + (l.last_week?.labour_cost ?? 0), 0) : 0);
    labourThen = prevNet > 0 && prevCost > 0 ? Math.round((prevCost / prevNet) * 1000) / 10 : null;
  }
  // Daily compliance checks over the period (or the day).
  const checks = ranged
    ? locs.reduce((t, l) => ({ done: t.done + (l.period?.daily.done ?? 0), due: t.due + (l.period?.daily.due ?? 0), fails: t.fails + (l.period?.daily.fails ?? 0) }), { done: 0, due: 0, fails: 0 })
    : { done: totals.dailyDone, due: totals.dailyDue, fails: totals.fails };
  const word = ranged ? PL(period).toLowerCase() : shown.isToday ? 'today' : '';
  // Each site's figures over the period, for its card.
  const siteSlice = (l) => {
    if (!ranged || !tradeRange) return null;
    const t = tradeRange.locations.find((x) => x.id === l.id);
    if (!t) return null;
    const synced = tradeRange.labour_synced;
    const p = tradePrev?.locations.find((x) => x.id === l.id);
    const prevCost = costOf(p, synced) + (sameTimeToo ? l.last_week?.labour_cost ?? 0 : 0);
    return { gross: t.gross_sales, grossThen: prevSales.get(l.id) ?? null, cost: costOf(t, synced), costThen: prevCost > 0 ? prevCost : null,
      labourPct: synced && t.labour_pct !== null ? t.labour_pct : t.rostered_labour_pct, basis: synced ? 'clocked' : 'rota' };
  };

  el.innerHTML = `<div class="dash-hip">
    <div class="page-head">
      <h1>HQ Dashboard <small class="muted">· ${state.multiSite ? 'All sites' : esc(state.location?.name ?? '')}</small></h1>
      <div class="actions">
        <button class="btn dash-pdf" id="dash-pdf">Download PDF</button>
      </div>
    </div>
    ${timeframeBar(t)}
    <p class="print-only print-meta">Atlas dashboard · ${fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · printed at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p>
    ${state.multiSite ? `
    ${hasSales ? `<div class="dash-hero">
      <div class="kpi kpi-feature" data-icon="£"><span>Gross sales ${word}</span><strong>${gross.now === null ? '–' : money(gross.now)}</strong>
        <small class="kpi-vs">${versusLine(gross.now, gross.then)}${ranged ? '' : openNote(locs)}</small></div>
      <div class="kpi kpi-${labourTone(labourPct)} dash-hero-labour" data-icon="◷"><span>Labour ${word}</span><strong>${fmtPct(labourPct)}</strong>
        <small class="kpi-vs">${labourVersus(labourPct, labourThen)}</small></div>
      <section class="card dash-hourly">
        <header class="dash-hourly-head"><h2>Gross sales by ${period === 'today' ? 'hour' : byMonth ? 'month' : 'day'}</h2>
          ${locs.length > 1 ? `<select id="hourly-site" class="hourly-site" aria-label="Site for the chart"><option value="">All sites</option>${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>` : ''}
          <div class="chart-legend"><span><i class="chart-legend-bar" style="background:var(--series-1)"></i>${ranged ? PL(period) : shown.isToday ? 'Today' : esc(dayWord())}</span><span><i class="chart-legend-bar" style="background:var(--prev-bar)"></i>vs ${ranged ? CN(period) : `${fmtDate(addDays(d0, -7), { weekday: 'long' })} last week`}</span></div></header>
        <div id="hourly-chart" class="chart-box"><div class="loading">Loading…</div></div>
      </section>
    </div>` : ''}
    <div class="kpis">
      <a class="kpi kpi-checks" href="#/safety"><span>Daily checks${word ? ` ${word}` : ''}</span>
        <div class="kpi-pair"><div><strong>${checks.done}<small> / ${checks.due}</small></strong><small>done${checks.due ? ` · ${Math.round((checks.done / checks.due) * 100)}%` : ''}</small></div>
          <div class="${checks.fails ? 'tone-bad' : ''}"><strong>${checks.fails}</strong><small>failed</small></div></div></a>
      ${clockedInNow === null ? '' : `<button type="button" class="kpi kpi-button kpi-compact" id="clocked-in-now" data-icon="☺" aria-haspopup="dialog"><span>${shown.isToday ? 'Clocked in now' : 'Clocked in'}</span><strong>${clockedInNow}</strong><small>${shown.isToday ? `of ${totals.staff} on today’s rota` : `${totals.staff} on the rota`} · <u>see who</u></small></button>`}
    </div>` : ''}
    <section class="card weather" id="weather" hidden></section>
    ${trade?.square_connected ? bySite(trade, period, prevSales, state) : ''}
    ${locs.some((l) => l.roster) ? whosIn(locs, data, fresh) : ''}
    ${security?.demo_password_accounts?.length ? `<p class="notice security-warning"><strong>⚠ Security: ${security.demo_password_accounts.length} account${security.demo_password_accounts.length === 1 ? '' : 's'} can still sign in with the demo password</strong> (${esc(security.demo_password_accounts.slice(0, 4).map((u) => u.email).join(', '))}${security.demo_password_accounts.length > 4 ? ', …' : ''}). Anyone who knows it could get in. Add <code>SEED_DEMO</code> = <code>false</code> in Railway → Variables to switch them all off, or give each a new password under People → Staff.</p>` : ''}
    ${leave.count ? `<p class="notice"><strong>${leave.count} holiday request${leave.count === 1 ? '' : 's'}</strong> waiting for approval. <a href="#/timeoff?tab=requests">Review ${leave.count === 1 ? 'it' : 'them'}</a></p>` : ''}
    <div class="site-cards">${locs.map((l) => card(l, state, data, siteSlice(l))).join('')}</div></div>`;

  el.querySelector('#dash-pdf').addEventListener('click', () => downloadPdf(state, data.date));
  wireTimeframe(el, { t, tf, today, navigate, page: 'dashboard', key: TF_KEY });
  // "Clocked in now": who's clocked in, site by site.
  el.querySelector('#clocked-in-now')?.addEventListener('click', () => {
    const sites = locs.map((l) => ({ l, people: (l.clock_ins ?? []).filter(inNow) })).filter((x) => x.people.length);
    openModal({
      title: shown.isToday ? `Clocked in now (${clockedInNow})` : `Clocked in · ${dayWord()} (${clockedInNow})`,
      body: sites.length ? sites.map(({ l, people }) => `<div class="clocked-site" style="--site: ${siteColour(l.name, l.id)}">
          <h3>${esc(l.name)} <span class="muted">${people.length}${shown.isToday ? ' in' : ''}</span></h3>
          <ul class="clocked-list">${people.sort((a, b) => a.start.localeCompare(b.start)).map((c) => `<li>
            ${cardLink(c.id, c.name)}
            <span class="muted">${c.end ? `${c.start}–${c.end}` : `since ${c.start}`}${c.rota ? ` · rota ${c.rota}` : c.not_on_rota ? ' · not on the rota' : ''}</span>
            <span>${c.end ? '' : c.on_break ? '<span class="badge badge-on-break">On break</span> ' : '<span class="badge badge-received">In</span> '}${duration(c.hours)}</span>
          </li>`).join('')}</ul></div>`).join('')
        : `<p class="muted">${shown.isToday ? 'Nobody is clocked in right now.' : 'Nobody clocked in that day.'}</p>`,
    });
    document.querySelectorAll('#modal-root [data-timecard]').forEach((b) => b.addEventListener('click', () => openTimecard(b.dataset.timecard)));
  });
  // London's 7-day forecast (loaded after the page, and simply left out if the weather service is unavailable).
  const weatherBox = el.querySelector('#weather');
  api('/weather').then((w) => {
    if (stale() || !weatherBox.isConnected || !w.days?.length) return;
    weatherBox.innerHTML = `<h2 class="weather-title">${esc(w.place)} weather</h2>
      <ol class="weather-days">${w.days.map((d, i) => `<li title="${esc(`${d.label}${d.rain !== null ? ` · ${d.rain}% chance of rain` : ''}`)}">
        <span class="wd-day">${i === 0 ? 'Today' : fmtDate(d.date, { weekday: 'short' })}</span>
        <span class="wd-icon" role="img" aria-label="${esc(d.label)}">${d.icon}</span>
        <span class="wd-temp"><strong>${d.max}°</strong> <span class="muted">${d.min}°</span></span>
        ${d.rain !== null ? `<span class="wd-rain ${d.rain >= 50 ? 'is-wet' : ''}">💧${d.rain}%</span>` : ''}
      </li>`).join('')}</ol>`;
    weatherBox.hidden = false;
  }).catch(() => {});
  // Gross sales by hour: today next to the same weekday last week.
  const chartBox = el.querySelector('#hourly-chart');
  // A site can be picked for the chart (remembered in this browser); otherwise it's every site shown.
  const siteBox = el.querySelector('#hourly-site');
  const SITE_KEY = `atlas:dash-hourly-site:${state.user.id}`;
  if (siteBox) {
    // Their own pick on this device, else their home site, else every site.
    let saved = null;
    try { saved = localStorage.getItem(SITE_KEY); } catch { /* storage unavailable */ }
    const home = homeSite(state);
    if (saved === '' || locs.some((l) => String(l.id) === saved)) siteBox.value = saved;
    else if (home && locs.some((l) => l.id === home)) siteBox.value = String(home);
    siteBox.addEventListener('change', () => {
      try { localStorage.setItem(SITE_KEY, siteBox.value); } catch { /* storage unavailable */ }
      loadChart();
    });
  }
  let chartSeq = 0;
  // Over a period: gross sales by day (by month for the year), next to the matching days it's compared with.
  const loadPeriodChart = async (seq, site) => {
    const pick = (x) => (site ? x?.locations.find((l) => String(l.id) === site) : x?.totals);
    const [cur, prev] = site
      ? await Promise.all([api(`/trading?from=${range.from}&to=${range.to}&location_id=${site}`), range.prevTo ? api(`/trading?from=${range.prevFrom}&to=${range.prevTo}&location_id=${site}`) : null])
      : [tradeRange, tradePrev];
    if (stale() || !chartBox.isConnected || seq !== chartSeq) return;
    if (!cur?.days?.length || !pick(cur)?.gross_sales) { chartBox.innerHTML = `<p class="muted small">No sales synced for this period${site ? ' at this site' : ''}.</p>`; return; }
    // Last week's matching day up to this time (week-type periods): from /dashboard, which every site card has.
    const sameTimeNow = locs.filter((l) => !site || String(l.id) === site).reduce((n, l) => n + (l.last_week?.gross ?? 0), 0);
    let rows;
    if (byMonth) {
      const monthly = (list) => list.reduce((m, d) => m.set(Number(d.date.slice(5, 7)), (m.get(Number(d.date.slice(5, 7))) ?? 0) + d.gross_sales), new Map());
      const now = monthly(cur.days);
      const then = monthly(prev?.days ?? []);
      // Custom dates are compared month by month with the same number of days before, in order.
      const thenInOrder = [...then.values()];
      rows = [...now.keys()].map((m, i) => ({ label: new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), title: new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }), now: now.get(m), then: period === 'custom' ? thenInOrder[i] ?? null : then.has(m) ? then.get(m) : null }));
    } else {
      rows = cur.days.map((d, i) => {
        const pd = prev?.days?.[i];
        const last = i === cur.days.length - 1 && sameTimeToo;
        return { label: period === 'mtd' ? String(Number(d.date.slice(8))) : period === 'custom' && cur.days.length > 7 ? fmtDate(d.date, { day: 'numeric', month: 'short' }) : fmtDate(d.date, { weekday: 'short' }), title: fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' }),
          now: d.gross_sales, then: last ? sameTimeNow : pd ? pd.gross_sales : null };
      });
    }
    const whole = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);
    pairedBarChart(chartBox, {
      data: rows,
      label: (x) => x.label,
      title: (x) => x.title,
      series: [
        { name: PL(period).toLowerCase(), value: (x) => x.now, color: 'var(--series-1)' },
        { name: CN(period), value: (x) => x.then, color: 'var(--prev-bar)' },
      ],
      fmt: money,
      fmtAxis: whole,
      height: 190,
      ariaLabel: `Gross sales by ${byMonth ? 'month' : 'day'}, ${PL(period).toLowerCase()}, against ${CN(period)}`,
    });
  };
  const loadChart = () => {
    const seq = ++chartSeq;
    const site = siteBox?.value || '';
    chartBox.innerHTML = '<div class="loading">Loading…</div>';
    el.querySelector('.dash-hourly .legend-open')?.remove();
    if (ranged) {
      loadPeriodChart(seq, site).catch((err) => {
        console.error('Period chart:', err);
        if (chartBox.isConnected) chartBox.innerHTML = `<p class="muted small">Couldn’t load the chart${err?.message ? ` (${esc(err.message)})` : ''}.</p>`;
      });
      return;
    }
    api(`/trading/hourly-compare?date=${d0}${site ? `&location_id=${site}` : ''}`).then((h) => {
      if (stale() || !chartBox.isConnected || seq !== chartSeq) return;
      if (!h.hours.length) { chartBox.innerHTML = `<p class="muted small">No sales synced ${shown.isToday ? 'yet today' : 'for this day'}${site ? ' at this site' : ''}.</p>`; return; }
      const hh = (n) => String(n).padStart(2, '0');
      const whole = (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `£${Math.round(v)}`);
      // Open (unpaid) orders show in orange on top of today's bars, and get a legend entry while there are any.
      if (h.hours.some((x) => x.open > 0)) {
        el.querySelector('.dash-hourly .chart-legend')?.insertAdjacentHTML('beforeend', '<span class="legend-open"><i class="chart-legend-bar" style="background:var(--open-bar)"></i>Open orders</span>');
      }
      pairedBarChart(chartBox, {
        data: h.hours,
        label: (x) => hh(x.hour),
        title: (x) => `${hh(x.hour)}:00–${hh(x.hour + 1)}:00`,
        series: [
          { name: shown.isToday ? 'today' : dayWord(), value: (x) => x.today, color: 'var(--series-1)', part: { name: 'of that, open orders', value: (x) => x.open, color: 'var(--open-bar)' } },
          { name: `${fmtDate(h.compare_date, { weekday: 'short', day: 'numeric', month: 'short' })}`, value: (x) => x.last_week, color: 'var(--prev-bar)' },
        ],
        fmt: money,
        fmtAxis: whole,
        height: 190,
        ariaLabel: `Gross sales by hour${site ? ` at ${siteBox.selectedOptions[0].textContent}` : ''}, today and the same day last week`,
      });
    }).catch((err) => {
      console.error('Hourly chart:', err);
      if (chartBox.isConnected) chartBox.innerHTML = `<p class="muted small">Couldn’t load the hourly chart${err?.message ? ` (${esc(err.message)})` : ''}.</p>`;
    });
  };
  if (chartBox) loadChart();
  wireClockInActions(el, { state, rerender });
  // Tapping a name opens that clock-in's timecard (from the site cards, Who's in, or the Clocked in list).
  const openTimecard = (id) => {
    for (const l of locs) {
      const c = (l.clock_ins ?? []).find((x) => String(x.id) === id);
      if (!c) continue;
      openModal({ title: `${c.name} – timecard`, body: `${timecardBody(c, l)}${clockInActions(state, c, l.id) ? `<p class="tc-actions">${clockInActions(state, c, l.id)}</p>` : ''}` });
      wireClockInActions(document.getElementById('modal-root'), { state, rerender });
      return;
    }
    toast('That timecard isn’t available any more', 'error');
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-timecard]');
    if (b) openTimecard(b.dataset.timecard);
  });
  wireSickButtons(el, rerender);
  // Hover or focus a site for its labour cost, hours and sales per labour hour.
  el.querySelectorAll('[data-site-row]').forEach((tr) => {
    const r = trade.locations.find((l) => l.id === Number(tr.dataset.siteRow));
    const clocked = trade.labour_synced && r.clocked_hours > 0;
    attachTip(tr, () => r.name, () => [
      { value: money(r.gross_sales), label: `gross sales · ${r.orders} orders` },
      ...(prevSales.get(r.id) ? [{ value: money(prevSales.get(r.id)), label: 'gross sales same time last week' }] : []),
      { value: money(r.net_sales), label: 'net sales (ex VAT)' },
      { value: money(clocked ? r.clocked_cost : r.rostered_cost), label: `labour (${clocked ? 'clocked' : 'rostered'}) · ${hrs(clocked ? r.clocked_hours : r.rostered_hours)}` },
      ...(r.sales_per_labour_hour !== null ? [{ value: money(r.sales_per_labour_hour), label: 'sales per labour hour' }] : []),
      ...(r.avg_spend !== null ? [{ value: money(r.avg_spend), label: 'average spend' }] : []),
    ]);
  });

  el.querySelectorAll('[data-open], [data-site]').forEach((b) => b.addEventListener('click', (e) => {
    const id = Number(b.dataset.open ?? b.dataset.site);
    if (state.multiSite) {
      chooseSite(state, id);
    }
    if (b.dataset.open) {
      e.preventDefault();
      navigate('safety');
    }
  }));
}
