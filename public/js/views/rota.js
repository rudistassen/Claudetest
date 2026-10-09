import { fmtPct, LABOUR_TARGET, labourTone } from './sales.js';
import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, select, showError, textarea, toast, todayISO, weekStart, chooseSite, siteColour } from '../lib.js';
import { shiftHistory } from './rotalog.js';
import { openStaffEditor } from './admin.js';
import { askToDrop, claimRequest, claimShift, dropsPanel, wireDrops } from './shiftdrops.js';
import { justImported, openRotaImport } from './rotaimport.js';
import { flaggedShifts, openRotaAnalysis, openSavedAnalysis } from './rotaanalyse.js';
import { sickDialog } from './sickness.js';

// A shift copied with Ctrl/⌘+click: its times stay here (across weeks and sites) until it's pasted somewhere with a
// click or Ctrl/⌘+V, or Esc clears it. Pasting opens the Add shift window filled in, to check before saving.
let copiedShift = null;
// The day the pointer is over, for Ctrl/⌘+V, and the page's paste action while the rota is open.
let hoverCell = null;
let pasteNow = null;
document.addEventListener('keydown', (e) => {
  if (!location.hash.startsWith('#/rota') || document.querySelector('.modal') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'Escape' && copiedShift) { copiedShift = null; pasteNow?.('clear'); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && copiedShift && hoverCell?.isConnected && pasteNow) { e.preventDefault(); pasteNow(hoverCell); }
});

// Ctrl+Z / ⌘Z on the rota undoes the last change (when there's one to undo and no form is open).
let undoNow = null;
document.addEventListener('keydown', (e) => {
  if (!undoNow || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  if (!location.hash.startsWith('#/rota') || document.querySelector('.modal') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  undoNow();
});

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  if (query.view === 'mine') return renderMine(ctx, weekStart(query.week || todayISO()));
  // The rota opens on the whole week's grid on a computer or tablet, and on today (only the shifts that are on) on a
  // phone, where the grid is cramped. Day / Week switch between them; a link to a particular day opens that day.
  const wide = window.matchMedia('(min-width: 700px)').matches;
  // Timeline: the week's grid with each day drawn as hours, and every shift as a bar across them (like a Gantt chart).
  const timeline = query.view === 'timeline';
  const view = query.view === 'week' || timeline ? 'week'
    : query.view === 'day' || query.day ? 'day'
      : query.week || wide ? 'week' : 'day';
  const day = view === 'day' ? (/^\d{4}-\d{2}-\d{2}$/.test(query.day ?? '') ? query.day : todayISO()) : null;
  const week = weekStart(day ?? query.week ?? todayISO());
  // People with more than one site can see every site's rota at once.
  // Which site: ?site=all or a site id. People with several sites start on All sites; the old ?scope= links still work.
  const active = state.locations.filter((l) => l.active);
  const asked = query.site ?? (query.scope === 'site' ? String(state.locationId) : query.scope === 'all' ? 'all' : null);
  const all = state.multiSite && (asked ?? 'all') === 'all';
  const siteId = all ? null : (active.find((l) => String(l.id) === asked)?.id ?? state.locationId);
  // Remember the site picked here, so other pages open on it too.
  if (siteId && siteId !== state.locationId) chooseSite(state, siteId);
  const siteParam = all ? 'all' : String(siteId);
  const mode = view === 'week' ? (timeline ? 'timeline' : 'week') : 'day';
  const scopeQs = (extra = {}) => qs({ view: mode, ...extra, site: state.multiSite ? siteParam : undefined });
  const [data, drops] = await Promise.all([api(`/rota${qs({ location_id: all ? 'all' : siteId, week })}`), api('/shift-drops')]);
  if (stale()) return;
  // The timeline can show one day of the week (?tday=) across the full width, or the whole week.
  const tday = timeline && data.days.includes(query.tday) ? query.tday : null;
  const shownDays = tday ? [tday] : data.days;
  // Open shifts (dropped and approved) at the sites shown, and shifts someone has asked to drop.
  const dropAsked = new Set(data.drop_requested ?? []);
  const openOn = (d) => (data.open_shifts ?? []).filter((x) => x.date === d);
  const dropTag = (s) => (s.sick ? '<em class="shift-tag tag-sick">Sick</em>' : '') + (dropAsked.has(s.id) ? '<em class="shift-tag tag-drop">Drop asked</em>' : '');
  const openButton = (x) => (x.status === 'claim_pending'
    ? `<button class="shift shift-open is-requested" data-open-shift="${x.id}" title="${esc(x.claimed_by_name)} has asked to pick this up – tap to approve"><span class="shift-time">${x.start_time}–${x.end_time}</span><small>✋ ${esc(x.claimed_by_name)} asked</small></button>`
    : `<button class="shift shift-open" data-open-shift="${x.id}" title="Open shift – tap to pick it up"><span class="shift-time">${x.start_time}–${x.end_time}</span>${all ? `<small>@ ${esc(x.location_name)}</small>` : ''}</button>`);
  const canEdit = state.can('rota.edit');
  const today = todayISO();
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';

  // Cells are keyed by person, site and day. On All sites each site has its own group of rows: everyone rostered
  // there that week, plus that site's own staff so they can be added. Someone working at two sites is in both.
  const cellKey = (userId, siteId, d) => `${userId}|${all ? siteId : ''}|${d}`;
  // Holiday and usual availability (sent to people who plan the rota).
  const weekdayOf = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  const holidayOn = (userId, d, status) => (data.leave ?? []).find((l) => l.user_id === userId && l.status === status && l.start_date <= d && l.end_date >= d);
  // What someone has said about a day (Time off → My availability): unavailable or available, all day or between
  // times – from that day or their repeating pattern.
  const availOn = (userId, d) => data.availability?.[userId]?.days?.[d] ?? [];
  const range = (a) => (a.all_day ? 'all day' : `${a.from_time}–${a.to_time}`);
  const cellNotes = (userId, d) => {
    if (holidayOn(userId, d, 'approved')) return '<span class="cell-note cell-holiday">Holiday</span>';
    const notes = [];
    if (holidayOn(userId, d, 'pending')) notes.push('<span class="cell-note cell-pending">Holiday requested</span>');
    for (const a of availOn(userId, d)) {
      notes.push(a.kind === 'unavailable'
        ? `<span class="cell-note cell-unavail" title="Not available ${range(a)}${a.source === 'pattern' ? ' (repeating)' : ''}">✕ ${a.all_day ? 'Not available' : `Not ${range(a)}`}</span>`
        : `<span class="cell-note cell-avail" title="Available ${range(a)}${a.source === 'pattern' ? ' (repeating)' : ''}">✓ ${a.all_day ? 'Available' : range(a)}</span>`);
    }
    return notes.join('');
  };
  // A gentle warning when a shift clashes with what someone said: unavailable then, or outside the times they said
  // they're available.
  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const availClash = (userId, d, start, end, name) => {
    const list = availOn(userId, d);
    if (!list.length || !start || !end) return '';
    const s = toMinutes(start);
    let e = toMinutes(end);
    if (e <= s) e = 24 * 60;
    const day = fmtDate(d, { weekday: 'long', day: 'numeric', month: 'short' });
    const off = list.filter((a) => a.kind === 'unavailable' && (a.all_day || (toMinutes(a.from_time) < e && toMinutes(a.to_time) > s)));
    if (off.length) return `${name} isn’t available ${off.some((a) => a.all_day) ? '' : `${off.map(range).join(', ')} `}on ${day}.`;
    const avail = list.filter((a) => a.kind === 'available' && !a.all_day);
    if (avail.length && !avail.some((a) => toMinutes(a.from_time) <= s && toMinutes(a.to_time) >= e)) {
      return `${name} said they’re available ${avail.map(range).join(', ')} on ${day}.`;
    }
    return '';
  };
  const byCell = new Map();
  for (const s of [...data.shifts, ...data.away_shifts.map((a) => ({ ...a, away: true }))]) {
    const k = cellKey(s.user_id, s.location_id, s.date);
    byCell.set(k, [...(byCell.get(k) ?? []), s]);
  }
  for (const list of byCell.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
  // Every shift someone works each day, at any site: wherever they appear on the rota, a day they're working at a
  // different site is greyed out and says where they are.
  const workingOn = new Map();
  for (const x of [...data.shifts, ...data.away_shifts]) {
    if (x.state === 'removed') continue;
    const k = `${x.user_id}|${x.date}`;
    workingOn.set(k, [...(workingOn.get(k) ?? []), x].sort((a, b) => a.start_time.localeCompare(b.start_time)));
  }
  const elsewhere = (userId, day, site) => (workingOn.get(`${userId}|${day}`) ?? []).filter((x) => x.location_id !== site);
  const coverAway = new Set(data.staff.flatMap((u) => data.days.filter((d) => elsewhere(u.id, d, u.location_id).length).map((d) => `${u.id}|${d}`)));
  // Removed shifts still show (struck through) for editors until the rota is published, but don't count.
  // Removed shifts and sickness don't count towards hours or labour cost.
  const counted = data.shifts.filter((x) => x.state !== 'removed' && !x.sick);
  // How the rota is laid out, remembered on this device: by site; site then role (Kitchen, Front of house…);
  // or role then site. On a single site's rota the last two both split it by role. (Roles are stored as rota_group.)
  const LAYOUT_KEY = 'cafe-ops:rota-layout';
  let layout = 'site';
  try {
    layout = localStorage.getItem(LAYOUT_KEY) ?? (localStorage.getItem('cafe-ops:rota-by-group') === '1' ? 'site-group' : 'site');
  } catch { /* storage unavailable */ }
  if (!['site', 'site-group', 'group-site'].includes(layout)) layout = 'site';
  const byGroup = layout !== 'site';
  const groupName = (u) => u.rota_group ?? '';
  const groupOrder = (a, b) => (a === '') - (b === '') || a.localeCompare(b);
  const hoursAt = (u, site) => counted.filter((x) => x.user_id === u.id && (!all || x.location_id === site)).reduce((t, x) => t + x.hours, 0);
  const rate = new Map(data.staff.map((u) => [u.id, u.hourly_rate]));
  const round1 = (n) => Math.round(n * 10) / 10;
  // Sub-heading rows: one per role (or per site), each followed by its people.
  const subRows = (people, site, groupId, label) => [
    { sub: label, site, groupId, people: new Set(people.map((u) => u.id)).size, hours: round1(people.reduce((t, u) => t + hoursAt(u, site), 0)) },
    ...people.map((u) => ({ u, site, groupId })),
  ];
  const byRotaGroup = (people, site, groupId) => [...new Set(people.map(groupName))].sort(groupOrder)
    .flatMap((name) => subRows(people.filter((u) => groupName(u) === name), site, groupId, name || 'No role'));
  // Everyone rostered at a site that week (its own staff first, then people covering from elsewhere).
  const sites = state.locations.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name));
  const peopleAt = (site) => {
    const working = new Set(data.shifts.filter((x) => x.location_id === site.id).map((x) => x.user_id));
    const people = data.staff.filter((u) => u.location_id === site.id || working.has(u.id));
    return [...people.filter((p) => p.location_id === site.id), ...people.filter((p) => p.location_id !== site.id)];
  };
  const summaryOf = (shifts, people) => ({
    people,
    hours: round1(shifts.reduce((t, x) => t + x.hours, 0)),
    // Pay rates are only sent to managers and admins.
    cost: data.labour_cost !== undefined ? shifts.reduce((t, x) => t + x.hours * (rate.get(x.user_id) ?? 0), 0) : null,
  });
  const rows = [];
  if (all && layout === 'group-site') {
    // Role first, then the sites its people are rostered at.
    const perSite = sites.map((site) => ({ site, people: peopleAt(site) })).filter((x) => x.people.length);
    const names = [...new Set(perSite.flatMap((x) => x.people.map(groupName)))].sort(groupOrder);
    for (const name of names) {
      const groupId = `rg:${name}`;
      const members = new Set(data.staff.filter((u) => groupName(u) === name).map((u) => u.id));
      const shifts = counted.filter((x) => members.has(x.user_id));
      const inGroup = perSite.map((x) => ({ site: x.site, people: x.people.filter((u) => groupName(u) === name) })).filter((x) => x.people.length);
      rows.push({ header: name || 'No role', groupId, summary: summaryOf(shifts, new Set(inGroup.flatMap((x) => x.people.map((u) => u.id))).size) });
      for (const { site, people } of inGroup) rows.push(...subRows(people, site.id, groupId, site.name));
    }
  } else if (all) {
    for (const site of sites) {
      const people = peopleAt(site);
      if (!people.length) continue;
      const groupId = String(site.id);
      rows.push({ header: site.name, groupId, summary: summaryOf(counted.filter((x) => x.location_id === site.id), people.length) });
      rows.push(...(byGroup ? byRotaGroup(people, site.id, groupId) : people.map((u) => ({ u, site: site.id, groupId }))));
    }
  } else {
    rows.push(...(byGroup ? byRotaGroup(data.staff, siteId, null) : data.staff.map((u) => ({ u, site: siteId, groupId: null }))));
  }
  // On the timeline, people within each site / role are ordered by when they're in: earliest first, people not
  // working (that day, or that week) at the bottom.
  if (timeline) {
    const firstIn = (u, site) => data.shifts
      .filter((x) => x.user_id === u.id && x.state !== 'removed' && (!all || x.location_id === site) && (tday ? x.date === tday : true))
      .map((x) => `${x.date} ${x.start_time} ${x.end_time}`).sort()[0] ?? null;
    for (let i = 0; i < rows.length;) {
      if (!rows[i].u) { i += 1; continue; }
      let j = i;
      while (j < rows.length && rows[j].u) j += 1;
      const run = rows.slice(i, j).map((r) => ({ r, key: firstIn(r.u, r.site) }))
        .sort((a, b) => (a.key === null) - (b.key === null) || (a.key ?? '').localeCompare(b.key ?? '') || a.r.u.name.localeCompare(b.r.u.name));
      rows.splice(i, j - i, ...run.map((x) => x.r));
      i = j;
    }
  }
  // Site layouts use the site id as each group's id.
  const siteOfGroup = (groupId) => (groupId && /^\d+$/.test(groupId) ? Number(groupId) : null);
  const groupForecast = (groupId) => {
    const id = siteOfGroup(groupId);
    const f = fc && id ? forecastWeek([id]) : null;
    if (f === null) return '';
    const p = pctOf(rotaCost([id]), f);
    return ` · ${budgeted([id]) ? 'budget' : 'forecast'} ${whole(grossWeek([id]))} gross · labour <span class="tone-${labourTone(p)}">${fmtPct(p)}</span>`;
  };
  const rowHours = (u, site) => Math.round(counted.filter((x) => x.user_id === u.id && (!all || x.location_id === site)).reduce((t, x) => t + x.hours, 0) * 100) / 100;
  // A shift at another site (greyed out on a single site's rota) says where it is; editors also see what's unpublished.
  const TAGS = { new: 'New', changed: 'Changed', removed: 'Removed' };
  const shiftLabel = (s, u, site) => {
    const where = s.location_id !== site ? `@ ${s.location_name}` : '';
    const tag = TAGS[s.state] ? `<em class="shift-tag">${TAGS[s.state]}</em>` : '';
    return `<span class="shift-time">${s.start_time}–${s.end_time}</span>${tag}${dropTag(s)}${where ? `<small>${esc(where)}</small>` : ''}`;
  };
  const shiftTitle = (s) => (s.state === 'new' ? 'New – staff can’t see this until you publish'
    : s.state === 'removed' ? 'Removed – staff still see this until you publish. Click to put it back.'
      : s.state === 'changed' ? `Changed – staff still see ${fmtDate(s.published.date)} ${s.published.start_time}–${s.published.end_time}${s.published.moved ? ' for someone else' : ''} at ${s.published.location_name} until you publish` : '');
  const dayHours = data.days.map((d) => counted.filter((s) => s.date === d).reduce((t, s) => t + s.hours, 0));
  const pending = data.unpublished ?? 0;

  // Expected sales (each weekday's average over recent weeks, bank holidays left out) and the rota's labour % against
  // them – for people who can see sales. Worked out from the draft, so it changes as shifts are added.
  const fc = data.forecast;
  const rateOf = new Map(data.staff.map((u) => [u.id, u.hourly_rate ?? 0]));
  const shownSites = all ? active.map((l) => l.id) : [siteId];
  const rotaCost = (ids, d) => counted.filter((x) => ids.includes(x.location_id) && (!d || x.date === d)).reduce((t, x) => t + x.hours * (rateOf.get(x.user_id) ?? 0), 0);
  // Sales planned for a day: the sales budget set for it (Rota → Sales budget), otherwise the forecast (that weekday's
  // average). Shown gross (grossFor; avgFor is the forecast alone); labour % and the labour budget use the net
  // equivalent (forecastFor) – a budget is turned into net with the site's own net-to-gross ratio.
  const budgetOf = (id, d) => data.sales_budget?.[id]?.[data.days.indexOf(d)] ?? null;
  const sumOver = (ids, d, one) => {
    let total = 0;
    let known = false;
    for (const id of ids) {
      const v = one(id, d);
      if (v !== null && v !== undefined) { total += v; known = true; }
    }
    return known ? total : null;
  };
  const fcOf = (id, d) => fc?.sites?.[id]?.[weekdayOf(d)] ?? null;
  const ratioOf = (id) => fc?.ratios?.[id] ?? 1 / 1.2;
  const avgFor = (ids, d) => sumOver(ids, d, (id) => fcOf(id, d)?.gross ?? null);
  const grossFor = (ids, d) => sumOver(ids, d, (id) => budgetOf(id, d) ?? fcOf(id, d)?.gross ?? null);
  const forecastFor = (ids, d) => sumOver(ids, d, (id) => (budgetOf(id, d) !== null ? budgetOf(id, d) * ratioOf(id) : fcOf(id, d)?.avg ?? null));
  const weekOf = (fn) => (ids) => {
    const vals = data.days.map((d) => fn(ids, d));
    return vals.some((v) => v !== null) ? vals.reduce((t, v) => t + (v ?? 0), 0) : null;
  };
  const forecastWeek = weekOf(forecastFor);
  const avgWeek = weekOf(avgFor);
  const grossWeek = weekOf(grossFor);
  // Whether any of these sites has a budget set on a day (or any day this week).
  const budgeted = (ids, d) => ids.some((id) => (d ? [d] : data.days).some((x) => budgetOf(id, x) !== null));
  const salesLabel = (ids) => (budgeted(ids) ? 'the sales budget in net sales' : 'forecast net sales');
  // Forecasts are estimates, so they're shown in whole pounds.
  const whole = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
  const pctOf = (cost, sales) => (sales ? Math.round((cost / sales) * 1000) / 10 : null);
  const fcCell = (ids, d) => {
    const f = forecastFor(ids, d);
    if (f === null) return '<span class="muted">–</span>';
    const p = pctOf(rotaCost(ids, d), f);
    return `<span class="${budgeted(ids, d) ? 'is-budget' : ''}" title="${budgeted(ids, d) ? 'Sales budget (gross)' : 'Forecast gross sales'} – labour % is of ${whole(f)} net">${whole(grossFor(ids, d))}</span><small class="tone-${labourTone(p)}">${fmtPct(p)}</small>`;
  };
  const bankHol = (d) => data.bank_holidays?.[d];

  // Opening hours (Setup → Locations): any time a site is open with nobody on the rota (sick and removed shifts
  // don't count) is flagged to people planning the rota, from today on.
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fromMin = (m) => (m >= 1440 ? '00:00' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const openingOf = (id) => {
    const l = state.locations.find((x) => x.id === id);
    try { return l?.opening_hours ? JSON.parse(l.opening_hours) : null; } catch { return null; }
  };
  const gapsFor = (id, d) => {
    const h = openingOf(id)?.[weekdayOf(d)];
    if (!h) return [];
    const open = toMin(h.open);
    const close = h.close === '00:00' ? 1440 : toMin(h.close);
    const spans = counted.filter((x) => x.location_id === id && x.date === d)
      .map((x) => { const a = toMin(x.start_time); const b = toMin(x.end_time); return [a, b <= a ? 1440 : b]; })
      .sort((x, y) => x[0] - y[0]);
    const gaps = [];
    let t = open;
    for (const [a, b] of spans) {
      if (t >= close) break;
      if (a > t) gaps.push([t, Math.min(a, close)]);
      t = Math.max(t, b);
    }
    if (t < close) gaps.push([t, close]);
    return gaps.map(([a, b]) => `${fromMin(a)}–${fromMin(b)}`);
  };
  const checkFrom = today;
  const gapList = canEdit ? shownSites.flatMap((id) => data.days.filter((d) => d >= checkFrom)
    .map((d) => ({ id, d, gaps: gapsFor(id, d) })).filter((g) => g.gaps.length)) : [];
  const gapsOn = (d, ids = shownSites) => gapList.filter((g) => g.d === d && ids.includes(g.id));
  const gapTag = (d) => {
    const g = gapsOn(d);
    return g.length ? `<small class="gap-tag" title="${esc(`Nobody on: ${g.map((x) => `${all ? `${siteName(x.id)} ` : ''}${x.gaps.join(', ')}`).join('; ')}`)}">⚠ Nobody on</small>` : '';
  };
  const gapsBox = (list) => {
    if (!list.length) return '';
    const n = list.reduce((t, g) => t + g.gaps.length, 0);
    return `<details class="rota-gaps" ${list.length <= 6 ? 'open' : ''}><summary>⚠ <strong>${n} time${n === 1 ? '' : 's'} with nobody on</strong> while ${all ? 'a site is' : 'the site is'} open</summary>
      <ul>${list.map((g) => `<li>${all ? `<strong>${esc(siteName(g.id))}</strong> · ` : ''}${fmtDate(g.d)}: ${g.gaps.join(', ')}</li>`).join('')}</ul></details>`;
  };
  const noHoursNote = canEdit && state.isAdmin && shownSites.some((id) => !openingOf(id))
    ? `<p class="muted small">Set ${all ? 'each site’s' : 'this site’s'} opening hours under <a href="#/admin/locations">Setup → Locations</a> to be warned when nobody is on while it’s open.</p>` : '';
  // Admins can click a name to open that person's staff details.
  const personName = (userId, name, tag = 'span') => (state.isAdmin
    ? `<button type="button" class="person-link" data-person="${userId}" title="Edit ${esc(name)}’s details">${esc(name)}</button>`
    : `<${tag}>${esc(name)}</${tag}>`);
  // For managers planning the week: the rota's cost so far (draft included) against a labour budget of
  // LABOUR_TARGET% of the week's forecast sales. Every change re-draws the page, so it keeps up as shifts go in.
  const labourTracker = () => {
    const sales = fc ? forecastWeek(shownSites) : null;
    if (sales === null || data.labour_cost === undefined) return '';
    const cost = rotaCost(shownSites);
    const budget = sales * (LABOUR_TARGET / 100);
    const p = pctOf(cost, sales);
    const left = budget - cost;
    const tone = labourTone(p);
    const fill = budget ? Math.min(100, (cost / budget) * 100) : 100;
    const perSite = all && shownSites.length > 1 ? shownSites.map((id) => {
      const f = forecastWeek([id]);
      if (f === null) return '';
      const sp = pctOf(rotaCost([id]), f);
      return `<span class="lt-site"><span class="lt-dot" style="--site: ${siteColour(siteName(id), id)}"></span>${esc(siteName(id))} <strong class="tone-${labourTone(sp)}">${fmtPct(sp)}</strong></span>`;
    }).filter(Boolean).join('') : '';
    return `<section class="card labour-track tone-box-${tone}" aria-label="Labour against budget">
      <div class="lt-figures">
        <div><span>${budgeted(shownSites) ? 'Sales budget (gross)' : 'Forecast gross sales'}</span><strong>${whole(grossWeek(shownSites))}</strong><small>${whole(sales)} net${budgeted(shownSites) && avgWeek(shownSites) !== null ? ` · forecast ${whole(avgWeek(shownSites))} gross` : ''}</small></div>
        <div><span>Labour budget for the week</span><strong>${whole(budget)}</strong><small>${LABOUR_TARGET}% of net sales</small></div>
        <div><span>Labour forecast</span><strong>${whole(cost)}</strong><small class="tone-${left >= 0 ? 'good' : 'bad'}">${whole(Math.abs(left))} ${left >= 0 ? 'under budget' : 'over budget'}</small></div>
        <div><span>Rota labour %</span><strong class="tone-${tone}">${fmtPct(p)}</strong><small>target ${LABOUR_TARGET}%</small></div>
      </div>
      <div class="lt-bar" role="meter" aria-valuemin="0" aria-valuemax="${Math.round(budget)}" aria-valuenow="${Math.round(cost)}" aria-label="Labour used of budget">
        <span class="lt-fill tone-bg-${tone}" style="width:${fill}%"></span></div>
      ${perSite ? `<div class="lt-sites">${perSite}</div>` : ''}
    </section>`;
  };
  const fcNote = fc ? `Sales are shown gross. Forecast = each day’s average gross sales over the last ${fc.weeks} weeks (bank holidays and closed days left out); where a sales budget is set for a day (Rota → Sales budget) it’s used instead. Labour % = the rota’s cost ÷ the net sales (after discounts, excluding VAT) – the forecast’s own net average, or the budget less VAT and discounts at the site’s usual rate.` : '';

  // --- Day view: just the shifts on one day, site by site: each person's name and a card with their times ---
  const dayView = () => {
    const onDay = data.shifts.filter((x) => x.date === day && (canEdit || x.state !== 'removed'));
    const person = (id) => data.staff.find((u) => u.id === id);
    const pendingDay = shownSites.reduce((t, id) => t + (data.unpublished_by_day?.[`${day}|${id}`] ?? 0), 0);
    const sections = shownSites.map((id) => ({
      id,
      name: siteName(id),
      list: onDay.filter((x) => x.location_id === id).sort((a, b) => a.start_time.localeCompare(b.start_time) || a.user_name.localeCompare(b.user_name)),
    }));
    const withShifts = sections.filter((x) => x.list.length);
    const without = sections.filter((x) => !x.list.length);
    const siteBlock = ({ id, name, list }) => {
      const live = list.filter((x) => x.state !== 'removed');
      const hours = Math.round(live.reduce((t, x) => t + x.hours, 0) * 10) / 10;
      const cost = rotaCost([id], day);
      const pendingHere = data.unpublished_by_day?.[`${day}|${id}`] ?? 0;
      return `<section class="card day-site">
        <header class="day-site-head">
          <div><h2>${esc(name)}</h2>
            <span class="muted small">${live.length} ${live.length === 1 ? 'shift' : 'shifts'} · ${hours} h${data.labour_cost !== undefined ? ` · ${money(cost)} labour` : ''}</span>
            ${gapsOn(day, [id]).length ? `<span class="gap-line">⚠ Nobody on ${gapsOn(day, [id])[0].gaps.join(', ')}</span>` : ''}</div>
          <div class="day-site-actions">
            ${canEdit && data.can_publish && pendingHere ? `<button class="btn btn-small" data-publish-site="${id}">Publish ${pendingHere} change${pendingHere === 1 ? '' : 's'}</button>` : ''}
            ${canEdit ? `<button class="btn btn-small" data-add-site="${id}">+ Add shift</button>` : ''}
          </div>
        </header>
        <ul class="day-list">
          ${list.map((x) => {
            const u = person(x.user_id);
            const from = u && u.location_id !== id && u.location_name ? `Covering from ${u.location_name}` : '';
            return `<li class="day-person ${x.state && x.state !== 'published' ? `is-${x.state}` : ''}" ${canEdit ? `data-drop data-user="${x.user_id}" data-date="${day}" data-site="${id}"` : ''}>
              <span class="day-name">${personName(x.user_id, x.user_name)}</span>
              <button class="day-card ${x.state && x.state !== 'published' ? `shift-${x.state}` : ''} ${x.sick ? 'shift-sick' : ''}" data-shift="${x.id}" ${canEdit ? '' : 'disabled'}
                title="${esc([shiftTitle(x), from].filter(Boolean).join(' · ') || `${x.start_time}–${x.end_time}`)}">
                <span>${x.start_time}–${x.end_time}</span>${TAGS[x.state] ? `<em class="shift-tag">${TAGS[x.state]}</em>` : ''}${dropTag(x)}</button>
            </li>`;
          }).join('')}
        </ul>
      </section>`;
    };
    const totalCost = rotaCost(shownSites, day);
    const liveCount = onDay.filter((x) => x.state !== 'removed').length;
    return `
      <div class="page-head">
        <h1>Rota · ${all ? 'All sites' : esc(state.location?.name ?? '')}</h1>
        <div class="actions">
          ${siteSelect}
          ${viewToggle}
          <button class="btn" data-day="-1" aria-label="Previous day">‹</button>
          <input type="date" id="rota-day" value="${day}" aria-label="Day">
          <button class="btn" data-day="1" aria-label="Next day">›</button>
          ${day !== today ? '<button class="btn" data-day="0">Today</button>' : ''}
          <a class="btn" href="#/rota${qs({ view: 'mine', week })}">My shifts</a>
        </div>
      </div>
      ${canEdit && pendingDay ? `
      <div class="publish-bar">
        <span><strong>${pendingDay} unpublished change${pendingDay === 1 ? '' : 's'}</strong> on this day – staff can’t see ${pendingDay === 1 ? 'it' : 'them'} yet.
          ${data.can_publish ? '' : 'Ask someone who can publish the rota to publish it.'}</span>
        <span class="publish-actions">${data.can_publish ? `<button class="btn btn-primary" id="publish">Publish this day${all ? ' (all sites)' : ''}</button>` : ''}</span>
      </div>` : ''}
      <h2 class="day-title">${day === today ? 'Today · ' : ''}${fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        ${bankHol(day) ? `<span class="badge badge-sent">${esc(bankHol(day))}</span>` : ''}</h2>
      <p class="muted">${liveCount} shift${liveCount === 1 ? '' : 's'}${data.labour_cost !== undefined ? ` · ${money(totalCost)} labour` : ''}</p>
      ${gapsBox(gapsOn(day))}
      ${openOn(day).length ? `<section class="card day-site day-open"><header class="day-site-head"><div><h2>Open shifts</h2><span class="muted small">Dropped by someone – tap one to pick it up</span></div></header>
        <ul class="day-list">${openOn(day).map((x) => `<li class="day-person"><span class="day-name">${esc(x.location_name)}</span>${openButton(x).replace('class="shift shift-open"', 'class="day-card shift-open"')}</li>`).join('')}</ul></section>` : ''}
      ${withShifts.length ? withShifts.map(siteBlock).join('') : `<div class="card empty">Nobody is on the rota ${day === today ? 'today' : 'this day'}.</div>`}
      ${canEdit && without.length && withShifts.length ? `<p class="muted small">No shifts at ${without.map((x) => `${esc(x.name)} <button class="link-btn" data-add-site="${x.id}">+ Add</button>`).join(' · ')}</p>` : ''}
      ${canEdit && !withShifts.length && without.length ? `<p>${without.map((x) => `<button class="btn btn-small" data-add-site="${x.id}">+ Add a shift at ${esc(x.name)}</button>`).join(' ')}</p>` : ''}
      ${canEdit ? '<p class="muted small">You’re seeing the draft rota. Tap a shift to change it, or to publish just that shift. Drag a shift onto someone else to give it to them (press and hold first on a phone).</p>' : ''}`;
  };

  // --- Day view on a phone: a clean list of shift cards (like the rota apps staff are used to) – the date across
  // the top, open shifts / leave / cost at a glance, then one card per shift, and a round + button to add one. ---
  const PD_ICON = {
    cup: '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M4 21h12"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    case: '<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
    plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/>',
    note: '<path d="M5 5h14v10H10l-4 3.5V15H5Z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  };
  const pdIcon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PD_ICON[n]}</svg>`;
  const initials = (name) => name.replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const phoneDayView = () => {
    const onDay = data.shifts.filter((x) => x.date === day && shownSites.includes(x.location_id) && (canEdit || x.state !== 'removed'))
      .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time) || a.user_name.localeCompare(b.user_name));
    const live = onDay.filter((x) => x.state !== 'removed');
    const published = live.filter((x) => !x.state || x.state === 'published').length;
    const person = (id) => data.staff.find((u) => u.id === id);
    const pendingDay = shownSites.reduce((t, id) => t + (data.unpublished_by_day?.[`${day}|${id}`] ?? 0), 0);
    const leaveToday = (data.leave ?? []).filter((l) => l.start_date <= day && l.end_date >= day);
    const onHol = leaveToday.filter((l) => l.status === 'approved').length;
    const open = openOn(day);
    const totalCost = rotaCost(shownSites, day);
    const card = (x) => {
      const u = person(x.user_id);
      const changed = x.state && x.state !== 'published';
      const status = changed ? `<em class="shift-tag">${TAGS[x.state]}</em>`
        : `<span class="pd-tick" title="${canEdit ? 'Published' : 'Confirmed'}">✓✓</span>`;
      const role = u?.rota_group || '';
      const from = u && u.location_id !== x.location_id && u.location_name ? `Covering from ${u.location_name}` : '';
      return `<li class="pd-item" ${canEdit ? `data-drop data-user="${x.user_id}" data-date="${day}" data-site="${x.location_id}"` : ''}>
        <button class="pd-card ${changed ? `is-${x.state}` : ''} ${x.sick ? 'shift-sick' : ''}" data-shift="${x.id}" ${canEdit ? '' : 'disabled'}
          style="--site:${siteColour(siteName(x.location_id), x.location_id)}" title="${esc([shiftTitle(x), from].filter(Boolean).join(' · ') || `${x.start_time}–${x.end_time}`)}">
          <span class="pd-avatar" aria-hidden="true">${esc(initials(x.user_name))}</span>
          <span class="pd-body">
            <span class="pd-time">${x.start_time} – ${x.end_time}<span class="pd-break">${pdIcon('cup')}${x.break_minutes ?? 0}m</span></span>
            <span class="pd-name">${esc(x.user_name)}</span>
            ${role ? `<span class="pd-line">${pdIcon('case')}${esc(role)}</span>` : ''}
            <span class="pd-line">${pdIcon('pin')}${esc(siteName(x.location_id))}${from ? ` · ${esc(from)}` : ''}</span>
          </span>
          <span class="pd-status">${status}${dropTag(x)}${x.notes ? `<span class="pd-note" title="${esc(x.notes)}">${pdIcon('note')}</span>` : ''}</span>
        </button>
      </li>`;
    };
    return `
      <div class="pd-head">
        ${siteSelect}
        ${viewToggle}
      </div>
      <div class="pd-datebar">
        <button class="pd-step" data-day="-1" aria-label="Previous day">‹</button>
        <label class="pd-date">${fmtDate(day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          <input type="date" id="rota-day" value="${day}" aria-label="Pick a day"></label>
        <button class="pd-step" data-day="1" aria-label="Next day">›</button>
      </div>
      ${day !== today || bankHol(day) ? `<p class="pd-sub">${bankHol(day) ? `<span class="badge badge-sent">${esc(bankHol(day))}</span>` : ''}
        ${day !== today ? '<button class="link-btn" data-day="0">Back to today</button>' : ''}</p>` : ''}
      <div class="pd-stats">
        <div class="pd-stat">
          <span class="pd-stat-icon">${pdIcon('target')}</span>
          <span><strong>${open.length} Open shift${open.length === 1 ? '' : 's'}</strong>
            <small>${canEdit ? `${published}/${live.length} published` : `${live.length} shift${live.length === 1 ? '' : 's'} on`}</small></span></div>
        <a class="pd-stat" href="#/timeoff">
          <span class="pd-stat-icon is-leave">${pdIcon('plane')}</span>
          <span><strong>${leaveToday.length} on leave</strong><small>${data.leave ? `${onHol}/${leaveToday.length} on holiday` : 'Holiday'}</small></span></a>
      </div>
      ${data.labour_cost !== undefined ? `<${state.can('sales.view') ? 'a href="#/rota-costs"' : 'div'} class="card pd-cost">
        <span><small>Cost summary</small><strong>${money(totalCost)}</strong></span>${state.can('sales.view') ? '<span class="pd-chev" aria-hidden="true">›</span></a>' : '</div>'}` : ''}
      ${canEdit && pendingDay ? `<div class="publish-bar">
        <span><strong>${pendingDay} unpublished change${pendingDay === 1 ? '' : 's'}</strong> – staff can’t see ${pendingDay === 1 ? 'it' : 'them'} yet.</span>
        ${data.can_publish ? `<span class="publish-actions"><button class="btn btn-primary" id="publish">Publish this day</button></span>` : ''}</div>` : ''}
      ${gapsBox(gapsOn(day))}
      ${open.length ? `<ul class="pd-list">${open.map((x) => `<li class="pd-item"><button class="pd-card pd-open" data-open-shift="${x.id}" style="--site:${siteColour(x.location_name, x.location_id)}">
          <span class="pd-avatar" aria-hidden="true">?</span>
          <span class="pd-body"><span class="pd-time">${x.start_time} – ${x.end_time}<span class="pd-break">${pdIcon('cup')}${x.break_minutes ?? 0}m</span></span><span class="pd-name">${x.status === 'claim_pending' ? `✋ ${esc(x.claimed_by_name)} asked to pick this up${canEdit ? ' – tap to approve' : ''}` : `Open shift – ${canEdit ? 'nobody on it yet' : 'tap to pick it up'}`}</span>
            <span class="pd-line">${pdIcon('pin')}${esc(x.location_name)}</span></span></button></li>`).join('')}</ul>` : ''}
      ${onDay.length ? `<ul class="pd-list">${onDay.map(card).join('')}</ul>` : `<div class="card empty">Nobody is on the rota ${day === today ? 'today' : 'this day'}.</div>`}
      ${canEdit ? `<button class="pd-fab" id="pd-fab" aria-label="Add a shift" aria-haspopup="${data.can_publish ? 'menu' : 'false'}" aria-expanded="false">+</button>
        ${data.can_publish ? `<div class="pd-fab-scrim" id="pd-fab-scrim" hidden></div><div class="pd-fab-menu" id="pd-fab-menu" role="menu" hidden>
          <button role="menuitem" data-fab="person"><span aria-hidden="true">👤</span>Shift for someone</button>
          <button role="menuitem" data-fab="open"><span aria-hidden="true">🔓</span>Open shift<small>Anyone from any site can pick it up</small></button></div>` : ''}
        <p class="muted small">Tap a shift to change it. Press and hold a shift, then drag it onto someone else’s to give it to them.</p>` : ''}`;
  };

  const siteSelect = state.multiSite ? `<select id="rota-site" aria-label="Site">
          <option value="all" ${all ? 'selected' : ''}>All sites</option>
          ${active.map((l) => `<option value="${l.id}" ${l.id === siteId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>` : '';
  const viewToggle = `<div class="seg" role="group" aria-label="Day, week or timeline">
          <button data-view="day" class="${mode === 'day' ? 'is-on' : ''}">Day</button><button data-view="week" class="${mode === 'week' ? 'is-on' : ''}">Week</button><button data-view="timeline" class="${mode === 'timeline' ? 'is-on' : ''}" title="The week as a timeline: each shift as a bar across the hours">Timeline</button></div>`;

  // --- Timeline: hours across each day, from the earliest start to the latest finish this week ---
  const toHours = (t) => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
  const spanOf = (x) => { const a = toHours(x.start_time); let b = toHours(x.end_time); if (b <= a) b = 24; return [a, b]; };
  // The hours shown run from the earliest start to the latest finish (that day, when showing one day).
  const allShown = [...data.shifts, ...data.away_shifts].filter((x) => !tday || x.date === tday);
  let tlFrom = allShown.length ? Math.floor(Math.min(...allShown.map((x) => spanOf(x)[0]))) : 7;
  let tlTo = allShown.length ? Math.ceil(Math.max(...allShown.map((x) => spanOf(x)[1]))) : 19;
  if (tlTo - tlFrom < 8) { tlTo = Math.min(24, tlFrom + 8); tlFrom = Math.max(0, tlTo - 8); }
  const tlPct = (h) => ((Math.min(Math.max(h, tlFrom), tlTo) - tlFrom) / (tlTo - tlFrom)) * 100;
  const tlStep = tlTo - tlFrom > 12 ? 4 : 2;
  const tlMarks = [];
  for (let h = Math.ceil(tlFrom / tlStep) * tlStep; h <= tlTo; h += tlStep) tlMarks.push(h);
  const tlGrid = `<span class="gt-grid" aria-hidden="true">${tlMarks.map((h) => `<i style="left:${tlPct(h)}%"></i>`).join('')}</span>`;
  const tlScale = `<span class="gt-scale" aria-hidden="true">${tlMarks.map((h) => `<i style="left:${tlPct(h)}%">${h === 24 ? '24' : String(h).padStart(2, '0')}</i>`).join('')}</span>`;
  const tlBar = (x, site, { away = false } = {}) => {
    const [a, b] = spanOf(x);
    const cls = away ? 'is-away' : [x.state && x.state !== 'published' ? `is-${x.state}` : '', x.sick ? 'is-sick' : ''].join(' ');
    const label = `${x.start_time}–${x.end_time}`;
    const tip = away ? `Covering at ${x.location_name} ${label}` : [label, shiftTitle(x), x.sick ? 'Off sick' : '', all ? `at ${x.location_name}` : ''].filter(Boolean).join(' · ');
    const tag = away ? 'span' : 'button';
    return `<${tag} class="gt-bar ${cls}" style="left:${tlPct(a)}%;width:${Math.max(tlPct(b) - tlPct(a), 2)}%;--site:${siteColour(siteName(x.location_id ?? site), x.location_id ?? site)}"
      ${away ? '' : `data-shift="${x.id}" ${canEdit ? '' : 'disabled'}`} title="${esc(tip)}"><span>${label}</span></${tag}>`;
  };
  // How many people are on at each hour of a day, as a little bar chart under the timeline.
  const tlCover = (d) => {
    const on = counted.filter((x) => x.date === d && shownSites.includes(x.location_id)).map(spanOf);
    const hours = [];
    for (let h = tlFrom; h < tlTo; h++) hours.push([h, on.filter(([a, b]) => a < h + 1 && b > h).length]);
    const peak = Math.max(1, ...hours.map(([, n]) => n));
    return `<div class="gt-cover">${hours.map(([h, n]) => `<span style="height:${(n / peak) * 100}%" title="${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${n} on"></span>`).join('')}</div>`;
  };
  // The week, centred under the title: a calendar to jump to any week, and ‹ › either side of its dates.
  const weekEnd = addDays(week, 6);
  const sameMonth = week.slice(0, 7) === weekEnd.slice(0, 7);
  const weekLabel = `${fmtDate(week, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmtDate(weekEnd, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const thisWeek = weekStart(today);
  const weekNav = `<div class="week-nav">
      <label class="btn week-pick" title="Pick a week"><span aria-hidden="true">📅</span><span class="sr-only">Pick a week</span>
        <input type="date" id="week-pick" value="${week}" aria-label="Pick a week"></label>
      <div class="week-step">
        <button class="btn btn-ghost" data-week="-7" aria-label="Previous week">‹</button>
        <strong>${weekLabel}</strong>
        <button class="btn btn-ghost" data-week="7" aria-label="Next week">›</button>
      </div>
      ${week !== thisWeek ? `<button class="btn btn-small btn-ghost" data-week="0">${week < thisWeek ? 'Back to this week' : 'This week'}</button>` : ''}
    </div>`;
  if (view === 'day') el.innerHTML = wide ? dayView() : phoneDayView();
  else el.innerHTML = `
    <div class="page-head">
      <h1>Rota · ${all ? 'All sites' : esc(state.location?.name ?? '')}</h1>
      <div class="actions">
        ${siteSelect}
        ${viewToggle}
        <select id="rota-layout" aria-label="View" title="How the rota is grouped (roles are set on the Staff page)">
          ${(all ? [['site', 'View: by site'], ['site-group', 'View: site, then role'], ['group-site', 'View: role, then site']]
            : [['site', 'View: everyone'], ['site-group', 'View: by role']])
            .map(([v, l]) => `<option value="${v}" ${(all ? layout : byGroup ? 'site-group' : 'site') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${all ? '<button class="btn" id="collapse-all"></button>' : ''}
        <a class="btn" href="#/rota${qs({ view: 'mine', week })}">My shifts</a>
        ${canEdit ? '<button class="btn" id="copy-week">Copy previous week</button>' : ''}
        ${state.isAdmin ? '<button class="btn btn-ai" id="read-rota" title="Upload a photo or PDF of a rota and Claude adds the shifts">✨ Read a rota</button>' : ''}
        ${state.isAdmin && data.shifts.length ? '<button class="btn btn-ai" id="analyse-rota" title="Claude compares this week’s rota with forecast sales and suggests where to save">📊 Analyse this week’s rota</button>' : ''}
        ${state.isAdmin && data.last_analysis ? '<button class="btn btn-ai" id="analysis-saved" title="Open the suggestions from the last analysis of this week">📋 Suggestions</button>' : ''}
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    ${weekNav}
    ${canEdit ? (pending ? `
    <div class="publish-bar">
      <span><strong>${pending} unpublished change${pending === 1 ? '' : 's'}</strong> – staff can’t see ${pending === 1 ? 'it' : 'them'} yet.
        ${data.can_publish ? '' : 'Ask someone who can publish the rota to publish it.'}</span>
      <span class="publish-actions">
        ${data.can_publish ? `<button class="btn btn-primary" id="publish">Publish ${all ? 'all sites' : 'this week'}</button>` : ''}
      </span>
    </div>` : '<p class="publish-ok">✓ Published – staff see this week as shown.</p>') : ''}
    ${labourTracker()}
    ${gapsBox(gapList)}
    ${timeline ? `<div class="tl-days" role="group" aria-label="Show one day or the whole week">
      <a class="tl-day ${tday ? '' : 'is-on'}" href="#/rota${scopeQs({ week })}">Whole week</a>
      ${data.days.map((d) => `<a class="tl-day ${d === tday ? 'is-on' : ''} ${d === today ? 'is-today' : ''}" href="#/rota${scopeQs({ week, tday: d })}">${fmtDate(d, { weekday: 'short', day: 'numeric' })}</a>`).join('')}
    </div>` : ''}
    <div class="table-wrap rota-scroll">
      <table class="rota ${timeline ? 'rota-gantt' : ''} ${tday ? 'rota-oneday' : ''}">
        <thead><tr><th>Staff</th>${shownDays.map((d) => `<th class="${d === today ? 'is-today' : ''}"><a class="day-link" href="#/rota${scopeQs({ view: 'day', day: d })}" title="See this day">${fmtDate(d)}</a>${bankHol(d) ? `<small class="bank-hol" title="${esc(bankHol(d))}">Bank holiday</small>` : ''}${gapTag(d)}${timeline ? tlScale : ''}</th>`).join('')}<th>${tday ? 'Week hours' : 'Hours'}</th></tr></thead>
        <tbody>
          ${(data.open_shifts ?? []).length ? `<tr class="rota-open"><th>Open shifts<small>tap to pick up</small></th>${shownDays.map((d) => `<td class="${d === today ? 'is-today' : ''}">${openOn(d).map(openButton).join('')}</td>`).join('')}<td></td></tr>` : ''}
          ${rows.map(({ header, groupId, summary, u, site, sub, people: subPeople, hours: subHours }) => (sub !== undefined ? `<tr class="rota-subgroup" ${groupId ? `data-in-group="${esc(groupId)}"` : ''}>
            <th colspan="${shownDays.length + 2}"><span class="rota-subgroup-name">${esc(sub)}</span>
              <span class="rota-group-meta">${subPeople} ${subPeople === 1 ? 'person' : 'people'} · ${subHours} h</span></th></tr>` : header ? `<tr class="rota-group ${layout === 'group-site' && all ? 'rota-group-by-rg' : ''}" data-group="${esc(groupId)}"${siteOfGroup(groupId) ? ` style="--site: ${siteColour(siteName(siteOfGroup(groupId)), siteOfGroup(groupId))}"` : ''}><th colspan="${shownDays.length + 2}">
            <div class="rota-group-line"><button class="rota-group-toggle" aria-expanded="true" data-toggle="${esc(groupId)}">
              <span class="rota-chevron" aria-hidden="true">▾</span>
              <span class="rota-group-name">${esc(header)}</span>
              <span class="rota-group-meta">${summary.people} ${summary.people === 1 ? 'person' : 'people'} · ${summary.hours} h${summary.cost === null ? '' : ` · ${money(summary.cost)} labour`}${groupForecast(groupId)}</span>
            </button>
            ${canEdit && data.can_publish && siteOfGroup(groupId) && data.unpublished_by_site?.[siteOfGroup(groupId)] ? `<button class="btn btn-small rota-publish-site" data-publish-site="${siteOfGroup(groupId)}">Publish ${esc(header)} (${data.unpublished_by_site[siteOfGroup(groupId)]})</button>` : ''}</div>
          </th></tr>
          ${fc && siteOfGroup(groupId) ? `<tr class="rota-forecast" data-in-group="${esc(groupId)}"><th>${budgeted([siteOfGroup(groupId)]) ? 'Budget' : 'Forecast'} gross sales · labour %</th>${shownDays.map((d) => `<td class="num">${fcCell([siteOfGroup(groupId)], d)}</td>`).join('')}<td></td></tr>` : ''}` : `
            <tr class="${u.location_id !== site ? 'rota-cover' : ''}" ${groupId ? `data-in-group="${esc(groupId)}"` : ''}>
              <th>${personName(u.id, u.name, 'strong')}${u.location_id !== site ? `<small>cover${u.location_name ? ` from ${esc(u.location_name)}` : ''}</small>` : ''}</th>
              ${shownDays.map((d) => {
                const shifts = (byCell.get(cellKey(u.id, site, d)) ?? []).filter((x) => !x.away);
                const off = !!holidayOn(u.id, d, 'approved');
                // On every row they appear in: a day spent working at another site is greyed out and says where.
                const away = elsewhere(u.id, d, site);
                const covering = away.length > 0 && !shifts.length;
                return `<td class="${d === today ? 'is-today' : ''} ${canEdit ? 'editable' : ''} ${off ? 'is-holiday' : ''} ${covering ? 'is-covering' : ''}" ${canEdit ? 'data-drop' : ''} data-user="${u.id}" data-date="${d}" data-site="${site}">
                  ${cellNotes(u.id, d)}
                  ${timeline ? '' : away.map((x) => { const where = x.location_name ?? siteName(x.location_id); const verb = site === u.location_id ? 'Covering at' : 'At'; return `<span class="cover-away" title="${verb} ${esc(where)} ${x.start_time}–${x.end_time}">${verb} ${esc(where)}<small>${x.start_time}–${x.end_time}</small></span>`; }).join('')}
                  ${timeline ? `<div class="gt-track">${tlGrid}${away.map((x) => tlBar(x, site, { away: true })).join('')}${shifts.map((x) => tlBar(x, site)).join('')}</div>`
                    : shifts.map((s) => `<button class="shift ${s.state && s.state !== 'published' ? `shift-${s.state}` : ''} ${s.sick ? 'shift-sick' : ''}" data-shift="${s.id}" ${canEdit ? '' : 'disabled'} title="${esc(shiftTitle(s))}">${shiftLabel(s, u, site)}</button>`).join('')}
                  ${canEdit && !shifts.length && !off && !covering ? '<span class="add-hint">+</span>' : ''}
                  ${canEdit && shifts.length && !off ? `<span class="add-more" title="Add another shift for ${esc(u.name)} on ${fmtDate(d)}">+ shift</span>` : ''}
                </td>`;
              }).join('')}
              <td class="num">${rowHours(u, site)}</td>
            </tr>`)).join('')}
        </tbody>
        <tfoot>${timeline ? `<tr class="gt-cover-row"><th>People on<small>by the hour</small></th>${shownDays.map((d) => `<td>${tlCover(d)}</td>`).join('')}<td></td></tr>` : ''}<tr><th>Total hours</th>${shownDays.map((d) => dayHours[data.days.indexOf(d)]).map((h) => `<td class="num">${Math.round(h * 100) / 100}</td>`).join('')}<td class="num"><strong>${data.total_hours}</strong></td></tr>
          ${data.daily_money ? `
          <tr><th>Labour cost</th>${shownDays.map((d) => data.daily_money[data.days.indexOf(d)]).map((m) => `<td class="num">${money(m?.labour_cost)}</td>`).join('')}<td class="num">${money(data.labour_cost)}</td></tr>
          ${fc ? `<tr class="rota-forecast-total"><th>Forecast gross sales<small>average for the day</small></th>${shownDays.map((d) => { const f = avgFor(shownSites, d); return `<td class="num">${f === null ? '–' : whole((f))}</td>`; }).join('')}<td class="num">${avgWeek(shownSites) === null ? '–' : whole((avgWeek(shownSites)))}</td></tr>
          ${budgeted(shownSites) ? `<tr class="rota-forecast-total rota-budget-row"><th>Sales budget (gross)<small><a href="#/rota/budget${qs({ week })}">forecast where none is set</a></small></th>${shownDays.map((d) => { const f = grossFor(shownSites, d); return `<td class="num ${budgeted(shownSites, d) ? 'is-budget' : ''}">${f === null ? '–' : whole((f))}</td>`; }).join('')}<td class="num"><strong>${grossWeek(shownSites) === null ? '–' : whole(grossWeek(shownSites))}</strong></td></tr>` : ''}
          <tr class="rota-forecast-total"><th>Rota labour %<small>of net sales</small></th>${shownDays.map((d) => { const p = pctOf(rotaCost(shownSites, d), forecastFor(shownSites, d)); return `<td class="num tone-${labourTone(p)}">${fmtPct(p)}</td>`; }).join('')}<td class="num tone-${labourTone(pctOf(rotaCost(shownSites), forecastWeek(shownSites)))}"><strong>${fmtPct(pctOf(rotaCost(shownSites), forecastWeek(shownSites)))}</strong></td></tr>` : ''}
          ${data.daily_money.some((m) => m.net_sales !== null) ? `
          <tr><th>Gross sales (Square)<small>actual so far</small></th>${shownDays.map((d) => data.daily_money[data.days.indexOf(d)] ?? {}).map((m) => `<td class="num">${m.gross_sales === null ? '–' : money(m.gross_sales)}</td>`).join('')}<td class="num">${money(data.week_gross_sales)}</td></tr>
          <tr><th>Labour %<small>of net sales</small></th>${shownDays.map((d) => data.daily_money[data.days.indexOf(d)] ?? {}).map((m) => `<td class="num tone-${labourTone(m.labour_pct)}">${fmtPct(m.labour_pct)}</td>`).join('')}<td class="num tone-${labourTone(data.labour_pct)}">${fmtPct(data.labour_pct)}</td></tr>` : ''}` : ''}
        </tfoot>
      </table>
    </div>
    ${!data.staff.length ? `<div class="empty">No staff ${all ? 'yet' : 'at this location yet'}. Add them under People → Staff.</div>` : ''}
    ${coverAway.size ? '<p class="muted small">Greyed-out days: that person is working at another site that day.</p>' : ''}
    ${byGroup && !data.staff.some((u) => u.rota_group) ? '<p class="muted small">Nobody has a role yet – set one for each person on the Staff page.</p>' : ''}
    ${fcNote ? `<p class="muted small">${fcNote}</p>` : ''}
    ${noHoursNote}
    ${canEdit ? '<p class="muted small">You’re seeing the draft rota: hours and costs include changes that aren’t published yet. Hover over a marked shift to see what staff currently see. Drag a shift onto another person or day to move it – hold Ctrl (⌥ on a Mac) as you drop to copy it instead. Or Ctrl+click (⌘ on a Mac) a shift to copy it, then click any day to paste it. On a phone, press and hold a shift first.</p>' : ''}`;

  el.querySelector('#rota-layout')?.addEventListener('change', (e) => {
    try { localStorage.setItem(LAYOUT_KEY, e.target.value); } catch { /* storage unavailable */ }
    ctx.rerender();
  });
  el.querySelector('#rota-site')?.addEventListener('change', (e) => ctx.navigate(`rota${qs(view === 'day' ? { view: 'day', day, site: e.target.value } : { view: mode, week, site: e.target.value })}`));
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === mode) return;
    ctx.navigate(`rota${scopeQs(b.dataset.view === 'day' ? { view: 'day', day: week === weekStart(today) ? today : week } : { view: b.dataset.view, week: weekStart(day ?? week) })}`);
  }));
  el.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.day);
    ctx.navigate(`rota${scopeQs({ day: n ? addDays(day, n) : undefined })}`);
  }));
  el.querySelector('#rota-day')?.addEventListener('change', (e) => { if (e.target.value) ctx.navigate(`rota${scopeQs({ day: e.target.value })}`); });

  // Folding sites away on All sites. Which are folded is remembered in this browser.
  const FOLD_KEY = 'cafe-ops:rota-collapsed';
  let folded = new Set();
  try { folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')); } catch { /* storage unavailable */ }
  const groups = [...el.querySelectorAll('tr.rota-group')].map((g) => g.dataset.group);
  const applyFolds = () => {
    for (const g of groups) {
      const shut = folded.has(g);
      el.querySelectorAll('tr[data-in-group]').forEach((tr) => { if (tr.dataset.inGroup === g) tr.hidden = shut; });
      const btn = [...el.querySelectorAll('[data-toggle]')].find((b) => b.dataset.toggle === g);
      btn.setAttribute('aria-expanded', String(!shut));
      btn.closest('tr').classList.toggle('is-folded', shut);
    }
    const allShut = groups.length && groups.every((g) => folded.has(g));
    const toggleAll = el.querySelector('#collapse-all');
    if (toggleAll) toggleAll.textContent = allShut ? 'Expand all' : 'Collapse all';
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* storage unavailable */ }
  };
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.toggle;
    if (folded.has(g)) folded.delete(g); else folded.add(g);
    applyFolds();
  }));
  el.querySelector('#collapse-all')?.addEventListener('click', () => {
    const allShut = groups.every((g) => folded.has(g));
    folded = allShut ? new Set([...folded].filter((g) => !groups.includes(g))) : new Set([...folded, ...groups]);
    applyFolds();
  });
  if (groups.length) applyFolds();

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const offset = Number(b.dataset.week);
    ctx.navigate(`rota${scopeQs({ week: offset ? addDays(week, offset) : undefined })}`);
  }));
  const pick = el.querySelector('#week-pick');
  pick?.addEventListener('click', () => { try { pick.showPicker(); } catch { /* the browser opens its own picker */ } });
  pick?.addEventListener('change', () => { if (pick.value) ctx.navigate(`rota${scopeQs({ week: weekStart(pick.value) })}`); });
  el.querySelector('#print')?.addEventListener('click', () => window.print());
  if (!canEdit) return;

  const staffOptions = data.staff.map((u) => [u.id, all && u.location_name ? `${u.name} (${u.location_name})` : u.name]);
  // Admins can put anyone on at any site; managers only run their own site.
  // Any site this person can access (admins: every site).
  const siteOptions = state.locations.filter((l) => l.active).map((l) => [l.id, l.name]);
  // Each site's most used shift times, fetched once per page.
  const commonTimes = new Map();
  const shiftModal = (shift, defaults = {}) => {
    const s = shift ?? { start_time: '07:00', end_time: '15:00', break_minutes: 30, ...defaults };
    const person = data.staff.find((u) => u.id === s.user_id);
    const site = s.location_id ?? (all ? person?.location_id : siteId) ?? state.locationId;
    const unpublished = shift && shift.state && shift.state !== 'published';
    // A new shift can be an open shift instead: nobody on it yet, and anyone from any site can pick it up.
    const canOpen = !shift && data.can_publish;
    const who = canOpen ? [...staffOptions, ['open', 'Open shift – nobody yet, anyone can pick it up']] : staffOptions;
    const { form } = openModal({
      title: shift ? 'Edit shift' : defaults.open ? 'Add open shift' : 'Add shift',
      body: `
        ${unpublished ? `<p class="notice publish-one">${shift.state === 'new' ? 'Staff can’t see this shift yet.' : 'Staff still see the old version of this shift.'}
          ${data.can_publish ? '<button type="button" class="btn btn-small btn-primary" id="publish-one">Publish just this shift</button>' : ''}</p>` : ''}
        ${shift ? `<p class="sick-line ${shift.sick ? 'is-sick' : ''}">${shift.sick ? `<span><strong>Off sick</strong>${shift.sick_note ? ` – ${esc(shift.sick_note)}` : ''}</span>` : '<span class="muted">Not coming in?</span>'}
          <span class="sick-line-actions">${data.can_publish && !shift.sick && shift.state !== 'removed' ? '<button type="button" class="btn btn-small" id="open-btn" title="Take it off their rota now and offer it to everyone">Drop to open</button>' : ''}
          <button type="button" class="btn btn-small" id="sick-btn">${shift.sick ? 'Change' : 'Mark as sick'}</button></span></p>` : ''}
        <div class="row">
          ${field('Staff member', select('user_id', who, defaults.open ? 'open' : s.user_id, 'required'))}
          ${field('Site', select('location_id', siteOptions, site, `required ${siteOptions.length > 1 ? '' : 'disabled'}`))}
        </div>
        ${field('Date', input('date', s.date, 'type="date" required'))}
        <p class="notice" id="avail-warn" hidden></p>
        <div class="row">
          ${field('Start', input('start_time', s.start_time, 'type="time" required'))}
          ${field('End', input('end_time', s.end_time, 'type="time" required'))}
        </div>
        <div class="time-presets" hidden><span class="muted small">Most used here:</span></div>
        ${field('Unpaid break (mins)', input('break_minutes', s.break_minutes, 'type="number" min="0" step="5"'))}
        <input type="hidden" name="position" value="${esc(s.position ?? person?.position ?? '')}">
        ${field('Notes', textarea('notes', s.notes))}
        ${shift ? '<details class="shift-history"><summary>History of this shift</summary><div id="shift-history" class="muted small">Loading…</div></details>' : ''}`,
      danger: shift ? 'Delete shift' : null,
      onDanger: async () => {
        const r = await api(`/shifts/${shift.id}`, { method: 'DELETE' });
        toast(r.removed_now ? (shift.state === 'new' ? 'Shift deleted' : 'Shift deleted – it’s off their rota now') : 'Shift removed. Staff will stop seeing it once someone publishes the rota.');
        ctx.rerender();
      },
      onSubmit: async (v) => {
        const body = { ...v, location_id: Number(v.location_id ?? site) };
        if (canOpen && v.user_id === 'open') {
          delete body.user_id;
          await api('/shift-drops', { method: 'POST', body });
          toast('Open shift added – anyone from any site can pick it up');
          ctx.rerender();
          return;
        }
        if (shift) await api(`/shifts/${shift.id}`, { method: 'PUT', body });
        else await api('/shifts', { method: 'POST', body });
        toast('Shift saved');
        ctx.rerender();
      },
    });
    form.querySelector('#open-btn')?.addEventListener('click', () => openModal({
      title: 'Drop to open?',
      body: `<p><strong>${esc(shift.user_name)}</strong> · ${fmtDate(shift.date)} · ${shift.start_time}–${shift.end_time}</p>
        <p class="muted small">It comes off ${esc(shift.user_name)}’s rota straight away and becomes an open shift at ${esc(siteName(shift.location_id))} that anyone, from any site, can pick up.</p>
        ${field('Reason (optional)', textarea('reason', '', 'maxlength="500" placeholder="e.g. Swapped to another site"'))}`,
      submitLabel: 'Drop to open',
      onSubmit: async (v) => {
        await api(`/shifts/${shift.id}/open`, { method: 'POST', body: { reason: v.reason } });
        toast('Shift is now open for anyone to pick up');
        ctx.rerender();
      },
    }));
    form.querySelector('#sick-btn')?.addEventListener('click', () => sickDialog({
      shift_id: shift.id, name: shift.user_name, date: shift.date, rota: `${shift.start_time}–${shift.end_time}`, sick: !!shift.sick, note: shift.sick_note,
    }, () => ctx.rerender()));
    // Warn (without blocking) when the shift is outside someone's usual availability or on a day they've asked off.
    const warn = form.querySelector('#avail-warn');
    const check = () => {
      const userId = Number(form.user_id.value);
      const d = form.date.value;
      if (form.user_id.value === 'open') { warn.hidden = true; return; }
      const name = data.staff.find((u) => u.id === userId)?.name ?? 'They';
      let msg = '';
      if (d && holidayOn(userId, d, 'approved')) msg = `${name} is on holiday that day, so this shift can’t be saved.`;
      else if (d && holidayOn(userId, d, 'pending')) msg = `${name} has asked for holiday that day.`;
      else if (d) msg = availClash(userId, d, form.start_time.value, form.end_time.value, name);
      warn.textContent = msg;
      warn.hidden = !msg;
    };
    ['user_id', 'date', 'start_time', 'end_time'].forEach((n) => form[n].addEventListener('change', check));
    check();
    // Quick times: the site's most used shift times over the last 4 weeks; clicking one fills in the times and break.
    const presets = form.querySelector('.time-presets');
    const showPresets = async () => {
      const siteNow = Number(form.location_id.value || site);
      let times = commonTimes.get(siteNow);
      if (!times) {
        try { times = await api(`/rota/common-times?location_id=${siteNow}`); } catch { times = []; }
        commonTimes.set(siteNow, times);
      }
      if (!form.isConnected || Number(form.location_id.value || site) !== siteNow) return;
      presets.querySelectorAll('button').forEach((b) => b.remove());
      presets.insertAdjacentHTML('beforeend', times.map((t) => `<button type="button" class="chip-btn" data-start="${t.start_time}" data-end="${t.end_time}" data-break="${t.break_minutes}"
        title="Used ${t.count} time${t.count === 1 ? '' : 's'} recently${t.break_minutes ? `, usually with a ${t.break_minutes}-minute break` : ''}">${t.start_time}–${t.end_time}</button>`).join(''));
      presets.hidden = !times.length;
      mark();
    };
    // The button matching the times entered is highlighted.
    const mark = () => presets.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.start === form.start_time.value && b.dataset.end === form.end_time.value));
    presets.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      form.start_time.value = b.dataset.start;
      form.end_time.value = b.dataset.end;
      form.break_minutes.value = b.dataset.break;
      mark();
      check();
    });
    form.start_time.addEventListener('input', mark);
    form.end_time.addEventListener('input', mark);
    form.location_id.addEventListener('change', showPresets);
    showPresets();
    form.querySelector('#publish-one')?.addEventListener('click', () => publishOne(shift));
    form.querySelector('.shift-history')?.addEventListener('toggle', async (e) => {
      const box = form.querySelector('#shift-history');
      if (!e.target.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      try { box.innerHTML = await shiftHistory(shift.id); box.classList.remove('muted', 'small'); } catch (err) { box.textContent = err.message; }
    });
  };
  // Publishes one shift as it's saved now (unsaved edits in the window aren't included).
  const publishOne = async (shift) => {
    try {
      await api(`/shifts/${shift.id}/publish`, { method: 'POST' });
      document.getElementById('modal-root').innerHTML = '';
      toast(shift.state === 'removed' ? 'Removal published – staff no longer see this shift' : `Published ${shift.user_name}’s shift`);
      ctx.rerender();
    } catch (err) { showError(err); }
  };

  // Drag a shift onto another person (or day) to move it there; hold Ctrl/⌥ as you drop to copy it.
  if (canEdit) {
    enableShiftDrag(el, {
      shiftFor: (id) => data.shifts.find((s) => s.id === id),
      onDrop: async (shift, target, copy) => {
        const to = { user_id: Number(target.dataset.user), date: target.dataset.date, location_id: Number(target.dataset.site) };
        if (!copy && to.user_id === shift.user_id && to.date === shift.date && to.location_id === shift.location_id) return;
        const name = data.staff.find((u) => u.id === to.user_id)?.name ?? 'them';
        if (holidayOn(to.user_id, to.date, 'approved')) { toast(`${name} is on holiday that day`, 'error'); return; }
        const body = { ...to, start_time: shift.start_time, end_time: shift.end_time, break_minutes: shift.break_minutes, position: shift.position, notes: shift.notes };
        // A copy opens the Add shift window filled in, to check (or change the times) before it's added.
        if (copy) { shiftModal(null, body); return; }
        try {
          await api(`/shifts/${shift.id}`, { method: 'PUT', body });
        } catch (err) { showError(err); return; }
        const who = to.user_id === shift.user_id ? '' : ` to ${name}`;
        const when = to.date === shift.date ? '' : ` on ${fmtDate(to.date)}`;
        toast(`${copy ? 'Copied' : 'Moved'} the ${shift.start_time}–${shift.end_time} shift${who}${when}`);
        // The same gentle warnings as the shift window: a day they've asked off, or outside their usual hours.
        let warning = '';
        if (holidayOn(to.user_id, to.date, 'pending')) warning = `${name} has asked for holiday that day.`;
        else warning = availClash(to.user_id, to.date, shift.start_time, shift.end_time, name);
        if (warning) setTimeout(() => toast(warning, 'error'), 2400);
        ctx.rerender();
      },
    });
  }

  // Drop requests to approve (and your own) above the rota; open shifts are picked up from the grid.
  el.querySelector('.page-head')?.insertAdjacentHTML('afterend', dropsPanel(drops, { open: false }));
  wireDrops(el, drops, () => ctx.rerender());
  // Undo: their last unpublished change, until they make another or publish.
  if (canEdit && data.undo) {
    el.querySelector('.page-head')?.insertAdjacentHTML('afterend', `<div class="undo-bar" role="status">
      <span><span class="muted">Last change:</span> ${esc(data.undo.label)}</span>
      <button type="button" class="btn btn-small" id="rota-undo" title="Undo (Ctrl+Z)">↶ Undo</button></div>`);
  }
  undoNow = data.undo ? async () => {
    undoNow = null;
    try {
      const r = await api('/rota/undo', { method: 'POST' });
      toast(`Undone: ${r.undone}`);
    } catch (err) { showError(err); }
    ctx.rerender();
  } : null;
  el.querySelector('#rota-undo')?.addEventListener('click', () => undoNow?.());
  el.querySelectorAll('[data-open-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = Number(b.dataset.openShift);
    const mine = drops.open.find((x) => x.id === id);
    const x = mine ?? data.open_shifts.find((o) => o.id === id);
    if (x.status === 'claim_pending') { claimRequest(x, () => ctx.rerender(), { canDecide: state.can('rota.publish') }); return; }
    claimShift(x, () => ctx.rerender(), { canClaim: !!mine?.can_claim, problem: mine ? mine.claim_problem : 'You don’t work at this site', canWithdraw: !!mine?.can_withdraw });
  }));
  el.querySelectorAll('[data-person]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openStaffEditor(ctx, Number(b.dataset.person)).catch(showError);
  }));
  // Copy and paste: Ctrl/⌘+click a shift to copy it; then click any day (or press Ctrl/⌘+V over one) to add it there.
  const copyBar = () => {
    el.querySelector('.copy-bar')?.remove();
    document.body.classList.toggle('rota-pasting', !!copiedShift && canEdit);
    if (!copiedShift || !canEdit) return;
    el.querySelector('.rota-scroll, .day-title')?.insertAdjacentHTML('beforebegin', `<div class="copy-bar" role="status">
      <span>📋 <strong>Copied ${esc(copiedShift.start_time)}–${esc(copiedShift.end_time)}</strong> (${esc(copiedShift.user_name)}) – click a day to add it there, or press Ctrl+V over one.</span>
      <button type="button" class="btn btn-small btn-ghost" id="copy-clear">Clear (Esc)</button></div>`);
    el.querySelector('#copy-clear').addEventListener('click', () => { copiedShift = null; copyBar(); });
  };
  const pasteInto = (cell) => {
    if (cell === 'clear') { copyBar(); return; }
    const c = copiedShift;
    shiftModal(null, { user_id: Number(cell.dataset.user), date: cell.dataset.date, location_id: Number(cell.dataset.site),
      start_time: c.start_time, end_time: c.end_time, break_minutes: c.break_minutes ?? 0, position: c.position, notes: c.notes });
  };
  pasteNow = canEdit ? pasteInto : null;
  el.querySelectorAll('td.editable').forEach((td) => {
    td.addEventListener('pointerenter', () => { hoverCell = td; });
    td.addEventListener('pointerleave', () => { if (hoverCell === td) hoverCell = null; });
  });
  copyBar();

  el.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const shift = data.shifts.find((s) => s.id === Number(b.dataset.shift));
    if (canEdit && (e.ctrlKey || e.metaKey) && shift.state !== 'removed') {
      copiedShift = { start_time: shift.start_time, end_time: shift.end_time, break_minutes: shift.break_minutes, position: shift.position, notes: shift.notes, user_name: shift.user_name };
      copyBar();
      toast(`Copied ${shift.start_time}–${shift.end_time} – click a day to add it there`);
      return;
    }
    if (shift.state === 'removed') {
      openModal({
        title: 'Removed shift',
        body: `<p>${esc(shift.user_name)}’s ${shift.start_time}–${shift.end_time} shift on ${fmtDate(shift.date)} has been removed, but staff still see it until it’s published.</p>`,
        submitLabel: 'Put it back',
        onSubmit: async () => { await api(`/shifts/${shift.id}/restore`, { method: 'POST' }); toast('Shift put back'); ctx.rerender(); },
        danger: data.can_publish ? 'Publish the removal' : null,
        onDanger: async () => publishOne(shift),
      });
      return;
    }
    shiftModal(shift);
  }));
  // Shifts at another site are edited from that site's rota (or All sites).
  el.querySelectorAll('.cover-away').forEach((a) => a.addEventListener('click', (e) => {
    e.stopPropagation();
    toast(`${a.title}. Edit it from that site’s rota${state.multiSite ? ' or All sites' : ''}.`);
  }));
  // A person can have more than one shift in a day (e.g. a split shift): a day that already has one suggests the
  // next starting when their last one ends.
  const addTime = (t, hours) => { const [h, m] = t.split(':').map(Number); const mins = Math.min(h * 60 + m + hours * 60, 23 * 60 + 59); return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; };
  el.querySelectorAll('td.editable').forEach((td) => td.addEventListener('click', () => {
    if (copiedShift) { pasteInto(td); return; }
    const userId = Number(td.dataset.user);
    const already = data.shifts.filter((x) => x.user_id === userId && x.date === td.dataset.date && x.state !== 'removed' && x.end_time > x.start_time);
    const lastEnd = already.map((x) => x.end_time).sort().pop();
    const next = lastEnd && lastEnd < '23:00' ? { start_time: lastEnd, end_time: addTime(lastEnd, 4), break_minutes: 0 } : {};
    shiftModal(null, { user_id: userId, date: td.dataset.date, location_id: Number(td.dataset.site), ...next });
  }));
  const scopeBody = { location_id: all ? 'all' : siteId, week, date: day ?? undefined };
  el.querySelector('#publish')?.addEventListener('click', async () => {
    if (!(await confirmDialog(day ? `Publish the changes on ${fmtDate(day)}${all ? ' at every site' : ''}? Staff will see that day as it is now.` : `Publish ${pending} change${pending === 1 ? '' : 's'}${all ? ' across every site' : ''}? Staff will see the rota as it is now.`, { confirmLabel: 'Publish', title: 'Publish rota' }))) return;
    try {
      const r = await api('/rota/publish', { method: 'POST', body: scopeBody });
      toast(`Published ${r.published} change${r.published === 1 ? '' : 's'}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
  el.querySelectorAll('[data-publish-site]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = Number(b.dataset.publishSite);
    const where = siteName(id);
    if (!(await confirmDialog(`Publish ${where}’s changes ${day ? `on ${fmtDate(day)}` : 'this week'}? Other sites stay as they are.`, { confirmLabel: `Publish ${where}`, title: 'Publish one site' }))) return;
    try {
      const r = await api('/rota/publish', { method: 'POST', body: { location_id: id, week, date: day ?? undefined } });
      toast(`Published ${r.published} change${r.published === 1 ? '' : 's'} at ${where}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  }));
  el.querySelectorAll('[data-add-site]').forEach((b) => b.addEventListener('click', () => shiftModal(null, { date: day ?? week, location_id: Number(b.dataset.addSite) })));
  // Phone day view: the round + button. People who can publish choose a shift for someone or an open shift.
  const fab = el.querySelector('#pd-fab');
  const fabMenu = el.querySelector('#pd-fab-menu');
  const fabSite = siteId ?? shownSites[0];
  const fabScrim = el.querySelector('#pd-fab-scrim');
  const showFabMenu = (show) => { if (!fabMenu) return; fabMenu.hidden = !show; fabScrim.hidden = !show; fab.setAttribute('aria-expanded', String(show)); fab.classList.toggle('is-open', show); };
  fab?.addEventListener('click', () => {
    if (!fabMenu) { shiftModal(null, { date: day, location_id: fabSite }); return; }
    showFabMenu(fabMenu.hidden);
  });
  fabMenu?.querySelectorAll('[data-fab]').forEach((b) => b.addEventListener('click', () => {
    showFabMenu(false);
    shiftModal(null, { date: day, location_id: fabSite, open: b.dataset.fab === 'open' });
  }));
  fabScrim?.addEventListener('click', () => showFabMenu(false));
  // Site headings stick just under the day headings while the rota scrolls.
  const scroller = el.querySelector('.rota-scroll');
  const head = scroller?.querySelector('thead');
  if (head) scroller.style.setProperty('--rota-head', `${head.getBoundingClientRect().height}px`);
  el.querySelector('#read-rota')?.addEventListener('click', () => openRotaImport({ location: all ? 'all' : siteId, week, onDone: () => ctx.rerender() }));
  el.querySelector('#analyse-rota')?.addEventListener('click', () => openRotaAnalysis({ location: all ? 'all' : siteId, week, onShow: () => ctx.rerender() }));
  el.querySelector('#analysis-saved')?.addEventListener('click', () => openSavedAnalysis({ location: all ? 'all' : siteId, week, onShow: () => ctx.rerender() }));
  // Shifts a rota-analysis suggestion is about glow, and the first is scrolled into view.
  if (flaggedShifts.size) {
    const hits = [...el.querySelectorAll('[data-shift]')].filter((b) => flaggedShifts.has(Number(b.dataset.shift)));
    hits.forEach((b) => b.classList.add('is-imported'));
    hits[0]?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    setTimeout(() => flaggedShifts.clear(), 0);
  }
  // Shifts just added from an uploaded rota glow until the page is next opened.
  if (justImported.size) {
    el.querySelectorAll('[data-shift]').forEach((b) => { if (justImported.has(Number(b.dataset.shift))) b.classList.add('is-imported'); });
    setTimeout(() => justImported.clear(), 0);
  }
  el.querySelector('#copy-week')?.addEventListener('click', async () => {
    const hasShifts = data.shifts.length > 0;
    if (!(await confirmDialog(
      hasShifts
        ? `Copy last week’s shifts${all ? ' at every site' : ''} into this week? Existing shifts stay; anything that would double-book someone is skipped. The copies stay as drafts until you publish.`
        : `Copy last week’s shifts${all ? ' at every site' : ''} into this week? The copies stay as drafts until you publish.`,
      { confirmLabel: 'Copy shifts', title: 'Copy previous week' },
    ))) return;
    try {
      const r = await api('/rota/copy-week', { method: 'POST', body: { location_id: all ? 'all' : siteId, from_week: addDays(week, -7), to_week: week } });
      toast(`Copied ${r.copied} shift(s)${r.skipped ? `, skipped ${r.skipped} (double-booked or on holiday)` : ''}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
}

// Just your own shifts for a week, at every site, as published. Easier to read on a phone than the full rota.
async function renderMine(ctx, week) {
  const { el, stale } = ctx;
  const shifts = await api(`/my-shifts${qs({ week })}`);
  if (stale()) return;
  const today = todayISO();
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const total = Math.round(shifts.reduce((t, s) => t + s.hours, 0) * 100) / 100;
  const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 2 })} h`;

  el.innerHTML = `
    <div class="page-head">
      <h1>My shifts</h1>
      <div class="actions">
        <a class="btn" href="#/rota${qs({ week })}">Whole rota</a>
        <button class="btn" data-week="-7">‹ Prev</button>
        <button class="btn" data-week="0">This week</button>
        <button class="btn" data-week="7">Next ›</button>
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    <p class="muted">Week commencing ${fmtDate(week, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      · ${shifts.length ? `<strong>${shifts.length} shift${shifts.length === 1 ? '' : 's'}, ${hrs(total)}</strong>` : 'no shifts'}</p>
    <section class="card my-shifts">
      ${days.map((d) => {
        const mine = shifts.filter((s) => s.date === d);
        return `<div class="my-day ${d === today ? 'is-today' : ''} ${mine.length ? '' : 'is-off'}">
          <div class="my-date"><strong>${fmtDate(d, { weekday: 'long' })}</strong><span>${fmtDate(d, { day: 'numeric', month: 'short' })}${d === today ? ' · today' : ''}</span></div>
          <div class="my-list">${mine.length ? mine.map((s) => `
            <div class="my-shift">
              <div class="my-time">${s.start_time}–${s.end_time}${s.sick ? ' <span class="badge badge-cancelled">Off sick</span>' : ''}</div>
              <div class="my-where">${esc(s.location_name)}<small>${hrs(s.hours)}${s.break_minutes ? ` · ${s.break_minutes} min break` : ''}${s.notes ? ` · ${esc(s.notes)}` : ''}</small></div>
              ${s.drop_requested ? '<div class="my-drop"><span class="badge badge-sent">Drop asked – waiting for a manager</span></div>' : s.can_drop ? `<div class="my-drop"><button class="btn btn-small btn-ghost" data-drop-shift="${s.id}">Drop shift</button></div>` : ''}
              ${s.colleagues ? `<div class="my-with small muted">${s.colleagues.length ? `With ${s.colleagues.map((c) => `${esc(c.name)} <span class="nowrap">${c.start_time}–${c.end_time}</span>`).join(', ')}` : 'Nobody else on'}</div>` : ''}
            </div>`).join('') : '<span class="muted">Day off</span>'}</div>
        </div>`;
      }).join('')}
    </section>
    <p class="muted small">These are your published shifts. Can’t make one? Tap “Drop shift” – once a manager approves, it’s offered to everyone. If something looks wrong, speak to your manager.</p>`;
  el.querySelectorAll('[data-drop-shift]').forEach((b) => b.addEventListener('click', () => askToDrop(shifts.find((s) => s.id === Number(b.dataset.dropShift)), () => ctx.rerender())));

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const offset = Number(b.dataset.week);
    ctx.navigate(`rota${qs({ view: 'mine', week: offset ? addDays(week, offset) : undefined })}`);
  }));
  el.querySelector('#print').addEventListener('click', () => window.print());
}

/**
 * Drag and drop for shifts, with a mouse or a finger. A mouse drag starts once the pointer moves a little; on a
 * touch screen, press and hold a shift first (so swiping still scrolls). Drop targets have data-drop, data-user,
 * data-date and data-site. A click straight after a drag doesn't open the shift.
 */
function enableShiftDrag(el, { shiftFor, onDrop }) {
  let drag = null;
  let suppressClick = false;
  const HOLD_MS = 350;
  const scroller = el.querySelector('.rota-scroll');

  const cleanup = () => {
    if (!drag) return;
    clearTimeout(drag.timer);
    drag.ghost?.remove();
    drag.btn.classList.remove('is-dragging');
    drag.over?.classList.remove('drop-over');
    document.body.classList.remove('rota-dragging');
    drag = null;
  };
  const begin = () => {
    const r = drag.btn.getBoundingClientRect();
    const ghost = drag.btn.cloneNode(true);
    ghost.className = `${drag.btn.className} shift-ghost`;
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.dx = drag.x - r.left;
    drag.dy = drag.y - r.top;
    drag.active = true;
    drag.btn.classList.add('is-dragging');
    document.body.classList.add('rota-dragging');
    if (drag.touch && navigator.vibrate) navigator.vibrate(15);
    place(drag.x, drag.y);
  };
  const place = (x, y) => {
    drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px)`;
    const target = document.elementFromPoint(x, y)?.closest('[data-drop]');
    const ok = target && el.contains(target) ? target : null;
    if (ok !== drag.over) {
      drag.over?.classList.remove('drop-over');
      ok?.classList.add('drop-over');
      drag.over = ok;
    }
    // Scroll when dragging near the edges.
    if (y < 70) window.scrollBy(0, -14);
    else if (y > innerHeight - 70) window.scrollBy(0, 14);
    if (scroller) {
      const s = scroller.getBoundingClientRect();
      if (x < s.left + 50) scroller.scrollLeft -= 14;
      else if (x > s.right - 50) scroller.scrollLeft += 14;
    }
  };

  el.querySelectorAll('[data-shift]').forEach((btn) => {
    const shift = shiftFor(Number(btn.dataset.shift));
    if (!shift || shift.state === 'removed') return;
    btn.classList.add('is-draggable');
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      const touch = e.pointerType !== 'mouse';
      drag = { btn, shift, x: e.clientX, y: e.clientY, touch, active: false, over: null };
      if (touch) drag.timer = setTimeout(() => { if (drag && !drag.active) begin(); }, HOLD_MS);
    });
    // No browser text selection or "save image" menu while holding a shift.
    btn.addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });
  });

  const onMove = (e) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.active) {
      if (drag.touch) { if (moved > 8) cleanup(); return; }
      if (moved < 6) return;
      begin();
    }
    place(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    if (!drag) return;
    const { active, over, shift } = drag;
    cleanup();
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (over) onDrop(shift, over, e.ctrlKey || e.altKey || e.metaKey);
  };
  // While dragging with a finger, stop the page scrolling instead.
  const onTouchMove = (e) => { if (drag?.active) e.preventDefault(); };
  const onKey = (e) => { if (e.key === 'Escape' && drag) { cleanup(); suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); } };
  const onClick = (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', cleanup);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', onClick, true);
  // Stop listening once the page is redrawn or replaced (its content is swapped out).
  // (Bars added above the rota – the undo bar, the copy bar – don't count: only the shifts being redrawn does.)
  const marker = el.querySelector('[data-shift], [data-drop]');
  const stop = new MutationObserver(() => {
    if (marker?.isConnected) return;
    stop.disconnect();
    cleanup();
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', cleanup);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('keydown', onKey);
    el.removeEventListener('click', onClick, true);
  });
  stop.observe(el, { childList: true });
}
