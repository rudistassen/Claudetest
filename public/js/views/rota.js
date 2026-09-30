import { fmtPct, labourTone } from './sales.js';
import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, select, showError, textarea, toast, todayISO, weekStart, chooseSite } from '../lib.js';
import { shiftHistory } from './rotalog.js';
import { openStaffEditor } from './admin.js';

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  if (query.view === 'mine') return renderMine(ctx, weekStart(query.week || todayISO()));
  // The rota opens on today (only the shifts that are on); the Week button shows the whole week's grid.
  const view = query.view === 'week' || (query.week && query.view !== 'day') ? 'week' : 'day';
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
  const scopeQs = (extra = {}) => qs({ view: view === 'week' ? 'week' : undefined, ...extra, site: state.multiSite ? siteParam : undefined });
  const data = await api(`/rota${qs({ location_id: all ? 'all' : siteId, week })}`);
  if (stale()) return;
  const canEdit = state.can('rota.edit');
  const today = todayISO();
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';

  // Cells are keyed by person, site and day. On All sites each site has its own group of rows: everyone rostered
  // there that week, plus that site's own staff so they can be added. Someone working at two sites is in both.
  const cellKey = (userId, siteId, d) => `${userId}|${all ? siteId : ''}|${d}`;
  // Holiday and usual availability (sent to people who plan the rota).
  const WEEKDAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  const weekdayOf = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  const holidayOn = (userId, d, status) => (data.leave ?? []).find((l) => l.user_id === userId && l.status === status && l.start_date <= d && l.end_date >= d);
  const availOn = (userId, d) => data.availability?.[userId]?.days?.[weekdayOf(d)] ?? null;
  const cellNotes = (userId, d) => {
    if (holidayOn(userId, d, 'approved')) return '<span class="cell-note cell-holiday">Holiday</span>';
    const notes = [];
    if (holidayOn(userId, d, 'pending')) notes.push('<span class="cell-note cell-pending">Holiday requested</span>');
    const a = availOn(userId, d);
    if (a?.status === 'none') notes.push('<span class="cell-note">Not available</span>');
    else if (a?.status === 'some') notes.push(`<span class="cell-note">${a.from_time}–${a.to_time} only</span>`);
    return notes.join('');
  };
  const byCell = new Map();
  for (const s of [...data.shifts, ...data.away_shifts.map((a) => ({ ...a, away: true }))]) {
    const k = cellKey(s.user_id, s.location_id, s.date);
    byCell.set(k, [...(byCell.get(k) ?? []), s]);
  }
  for (const list of byCell.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
  // Shifts someone is covering away from their home site, by person and day: their home-site day is greyed out
  // and says where they are.
  const coverAway = new Map();
  for (const x of [...data.shifts, ...data.away_shifts]) {
    const u = data.staff.find((p) => p.id === x.user_id);
    if (!u || x.state === 'removed' || !u.location_id || x.location_id === u.location_id) continue;
    const k = `${x.user_id}|${x.date}`;
    coverAway.set(k, [...(coverAway.get(k) ?? []), x].sort((a, b) => a.start_time.localeCompare(b.start_time)));
  }
  // Removed shifts still show (struck through) for editors until the rota is published, but don't count.
  const counted = data.shifts.filter((x) => x.state !== 'removed');
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
  // Site layouts use the site id as each group's id.
  const siteOfGroup = (groupId) => (groupId && /^\d+$/.test(groupId) ? Number(groupId) : null);
  const groupForecast = (groupId) => {
    const id = siteOfGroup(groupId);
    const f = fc && id ? forecastWeek([id]) : null;
    if (f === null) return '';
    const p = pctOf(rotaCost([id]), f);
    return ` · forecast ${whole((f))} · labour <span class="tone-${labourTone(p)}">${fmtPct(p)}</span>`;
  };
  const rowHours = (u, site) => Math.round(counted.filter((x) => x.user_id === u.id && (!all || x.location_id === site)).reduce((t, x) => t + x.hours, 0) * 100) / 100;
  // A shift at another site (greyed out on a single site's rota) says where it is; editors also see what's unpublished.
  const TAGS = { new: 'New', changed: 'Changed', removed: 'Removed' };
  const shiftLabel = (s, u, site) => {
    const where = s.location_id !== site ? `@ ${s.location_name}` : '';
    const tag = TAGS[s.state] ? `<em class="shift-tag">${TAGS[s.state]}</em>` : '';
    return `<span class="shift-time">${s.start_time}–${s.end_time}</span>${tag}${where ? `<small>${esc(where)}</small>` : ''}`;
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
  const forecastFor = (ids, d) => {
    let total = 0;
    let known = false;
    for (const id of ids) {
      const f = fc?.sites?.[id]?.[weekdayOf(d)];
      if (f) { total += f.avg; known = true; }
    }
    return known ? total : null;
  };
  const forecastWeek = (ids) => {
    const vals = data.days.map((d) => forecastFor(ids, d));
    return vals.some((v) => v !== null) ? vals.reduce((t, v) => t + (v ?? 0), 0) : null;
  };
  // Forecasts are estimates, so they're shown in whole pounds.
  const whole = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
  const pctOf = (cost, sales) => (sales ? Math.round((cost / sales) * 1000) / 10 : null);
  const fcCell = (ids, d) => {
    const f = forecastFor(ids, d);
    if (f === null) return '<span class="muted">–</span>';
    const p = pctOf(rotaCost(ids, d), f);
    return `${whole((f))}<small class="tone-${labourTone(p)}">${fmtPct(p)}</small>`;
  };
  const bankHol = (d) => data.bank_holidays?.[d];
  // Admins can click a name to open that person's staff details.
  const personName = (userId, name, tag = 'span') => (state.isAdmin
    ? `<button type="button" class="person-link" data-person="${userId}" title="Edit ${esc(name)}’s details">${esc(name)}</button>`
    : `<${tag}>${esc(name)}</${tag}>`);
  const fcNote = fc ? `Forecast = each day’s average sales over the last ${fc.weeks} weeks (bank holidays and closed days left out); labour % = the rota’s cost ÷ that forecast.` : '';

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
            <span class="muted small">${live.length} ${live.length === 1 ? 'shift' : 'shifts'} · ${hours} h${data.labour_cost !== undefined ? ` · ${money(cost)} labour` : ''}</span></div>
          <div class="day-site-actions">
            ${canEdit && data.can_publish && pendingHere ? `<button class="btn btn-small" data-publish-site="${id}">Publish ${pendingHere} change${pendingHere === 1 ? '' : 's'}</button>` : ''}
            ${canEdit ? `<button class="btn btn-small" data-add-site="${id}">+ Add shift</button>` : ''}
          </div>
        </header>
        <ul class="day-list">
          ${list.map((x) => {
            const u = person(x.user_id);
            const from = u && u.location_id !== id && u.location_name ? `Covering from ${u.location_name}` : '';
            return `<li class="day-person ${x.state && x.state !== 'published' ? `is-${x.state}` : ''}">
              <span class="day-name">${personName(x.user_id, x.user_name)}</span>
              <button class="day-card ${x.state && x.state !== 'published' ? `shift-${x.state}` : ''}" data-shift="${x.id}" ${canEdit ? '' : 'disabled'}
                title="${esc([shiftTitle(x), from].filter(Boolean).join(' · ') || `${x.start_time}–${x.end_time}`)}">
                <span>${x.start_time}–${x.end_time}</span>${TAGS[x.state] ? `<em class="shift-tag">${TAGS[x.state]}</em>` : ''}</button>
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
      ${withShifts.length ? withShifts.map(siteBlock).join('') : `<div class="card empty">Nobody is on the rota ${day === today ? 'today' : 'this day'}.</div>`}
      ${canEdit && without.length && withShifts.length ? `<p class="muted small">No shifts at ${without.map((x) => `${esc(x.name)} <button class="link-btn" data-add-site="${x.id}">+ Add</button>`).join(' · ')}</p>` : ''}
      ${canEdit && !withShifts.length && without.length ? `<p>${without.map((x) => `<button class="btn btn-small" data-add-site="${x.id}">+ Add a shift at ${esc(x.name)}</button>`).join(' ')}</p>` : ''}
      ${canEdit ? '<p class="muted small">You’re seeing the draft rota. Tap a shift to change it, or to publish just that shift.</p>' : ''}`;
  };

  const siteSelect = state.multiSite ? `<select id="rota-site" aria-label="Site">
          <option value="all" ${all ? 'selected' : ''}>All sites</option>
          ${active.map((l) => `<option value="${l.id}" ${l.id === siteId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>` : '';
  const viewToggle = `<div class="seg" role="group" aria-label="Day or week">
          <button data-view="day" class="${view === 'day' ? 'is-on' : ''}">Day</button><button data-view="week" class="${view === 'week' ? 'is-on' : ''}">Week</button></div>`;
  if (view === 'day') el.innerHTML = dayView();
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
        <button class="btn" data-week="-7">‹ Prev</button>
        <button class="btn" data-week="0">This week</button>
        <button class="btn" data-week="7">Next ›</button>
        ${canEdit ? '<button class="btn" id="copy-week">Copy previous week</button>' : ''}
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    ${canEdit ? (pending ? `
    <div class="publish-bar">
      <span><strong>${pending} unpublished change${pending === 1 ? '' : 's'}</strong> – staff can’t see ${pending === 1 ? 'it' : 'them'} yet.
        ${data.can_publish ? '' : 'Ask someone who can publish the rota to publish it.'}</span>
      <span class="publish-actions">
        <button class="btn" id="discard">Discard changes</button>
        ${data.can_publish ? `<button class="btn btn-primary" id="publish">Publish ${all ? 'all sites' : 'this week'}</button>` : ''}
      </span>
    </div>` : '<p class="publish-ok">✓ Published – staff see this week as shown.</p>') : ''}
    <p class="muted">Week commencing ${fmtDate(week, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      · ${data.total_hours} hours${data.labour_cost !== undefined ? ` · labour cost ${money(data.labour_cost)}` : ''}
      ${data.week_sales ? ` · sales to date ${money(data.week_sales)} · labour <span class="tone-${labourTone(data.labour_pct)}">${fmtPct(data.labour_pct)}</span> of sales to date` : ''}</p>
    <div class="table-wrap rota-scroll">
      <table class="rota">
        <thead><tr><th>Staff</th>${data.days.map((d) => `<th class="${d === today ? 'is-today' : ''}"><a class="day-link" href="#/rota${scopeQs({ view: undefined, day: d })}" title="See this day">${fmtDate(d)}</a>${bankHol(d) ? `<small class="bank-hol" title="${esc(bankHol(d))}">Bank holiday</small>` : ''}</th>`).join('')}<th>Hours</th></tr></thead>
        <tbody>
          ${rows.map(({ header, groupId, summary, u, site, sub, people: subPeople, hours: subHours }) => (sub !== undefined ? `<tr class="rota-subgroup" ${groupId ? `data-in-group="${esc(groupId)}"` : ''}>
            <th colspan="${data.days.length + 2}"><span class="rota-subgroup-name">${esc(sub)}</span>
              <span class="rota-group-meta">${subPeople} ${subPeople === 1 ? 'person' : 'people'} · ${subHours} h</span></th></tr>` : header ? `<tr class="rota-group ${layout === 'group-site' && all ? 'rota-group-by-rg' : ''}" data-group="${esc(groupId)}"><th colspan="${data.days.length + 2}">
            <div class="rota-group-line"><button class="rota-group-toggle" aria-expanded="true" data-toggle="${esc(groupId)}">
              <span class="rota-chevron" aria-hidden="true">▾</span>
              <span class="rota-group-name">${esc(header)}</span>
              <span class="rota-group-meta">${summary.people} ${summary.people === 1 ? 'person' : 'people'} · ${summary.hours} h${summary.cost === null ? '' : ` · ${money(summary.cost)} labour`}${groupForecast(groupId)}</span>
            </button>
            ${canEdit && data.can_publish && siteOfGroup(groupId) && data.unpublished_by_site?.[siteOfGroup(groupId)] ? `<button class="btn btn-small rota-publish-site" data-publish-site="${siteOfGroup(groupId)}">Publish ${esc(header)} (${data.unpublished_by_site[siteOfGroup(groupId)]})</button>` : ''}</div>
          </th></tr>
          ${fc && siteOfGroup(groupId) ? `<tr class="rota-forecast" data-in-group="${esc(groupId)}"><th>Forecast · labour %</th>${data.days.map((d) => `<td class="num">${fcCell([siteOfGroup(groupId)], d)}</td>`).join('')}<td></td></tr>` : ''}` : `
            <tr class="${u.location_id !== site ? 'rota-cover' : ''}" ${groupId ? `data-in-group="${esc(groupId)}"` : ''}>
              <th>${personName(u.id, u.name, 'strong')}${u.location_id !== site ? `<small>cover${u.location_name ? ` from ${esc(u.location_name)}` : ''}</small>` : ''}</th>
              ${data.days.map((d) => {
                const shifts = (byCell.get(cellKey(u.id, site, d)) ?? []).filter((x) => !x.away);
                const off = !!holidayOn(u.id, d, 'approved');
                // On their home site's row: a day spent covering elsewhere is greyed out and says where.
                const away = site === u.location_id ? coverAway.get(`${u.id}|${d}`) ?? [] : [];
                const covering = away.length > 0 && !shifts.length;
                return `<td class="${d === today ? 'is-today' : ''} ${canEdit ? 'editable' : ''} ${off ? 'is-holiday' : ''} ${covering ? 'is-covering' : ''}" data-user="${u.id}" data-date="${d}" data-site="${site}">
                  ${cellNotes(u.id, d)}
                  ${away.map((x) => `<span class="cover-away" title="Covering at ${esc(x.location_name)} ${x.start_time}–${x.end_time}">Covering at ${esc(x.location_name)}<small>${x.start_time}–${x.end_time}</small></span>`).join('')}
                  ${shifts.map((s) => `<button class="shift ${s.state && s.state !== 'published' ? `shift-${s.state}` : ''}" data-shift="${s.id}" ${canEdit ? '' : 'disabled'} title="${esc(shiftTitle(s))}">${shiftLabel(s, u, site)}</button>`).join('')}
                  ${canEdit && !shifts.length && !off && !covering ? '<span class="add-hint">+</span>' : ''}
                </td>`;
              }).join('')}
              <td class="num">${rowHours(u, site)}</td>
            </tr>`)).join('')}
        </tbody>
        <tfoot><tr><th>Total hours</th>${dayHours.map((h) => `<td class="num">${Math.round(h * 100) / 100}</td>`).join('')}<td class="num"><strong>${data.total_hours}</strong></td></tr>
          ${data.daily_money ? `
          <tr><th>Labour cost</th>${data.daily_money.map((m) => `<td class="num">${money(m.labour_cost)}</td>`).join('')}<td class="num">${money(data.labour_cost)}</td></tr>
          ${fc ? `<tr class="rota-forecast-total"><th>Forecast sales<small>average for the day</small></th>${data.days.map((d) => { const f = forecastFor(shownSites, d); return `<td class="num">${f === null ? '–' : whole((f))}</td>`; }).join('')}<td class="num">${forecastWeek(shownSites) === null ? '–' : whole((forecastWeek(shownSites)))}</td></tr>
          <tr class="rota-forecast-total"><th>Rota labour %<small>of forecast sales</small></th>${data.days.map((d) => { const p = pctOf(rotaCost(shownSites, d), forecastFor(shownSites, d)); return `<td class="num tone-${labourTone(p)}">${fmtPct(p)}</td>`; }).join('')}<td class="num tone-${labourTone(pctOf(rotaCost(shownSites), forecastWeek(shownSites)))}"><strong>${fmtPct(pctOf(rotaCost(shownSites), forecastWeek(shownSites)))}</strong></td></tr>` : ''}
          ${data.daily_money.some((m) => m.net_sales !== null) ? `
          <tr><th>Sales (Square)</th>${data.daily_money.map((m) => `<td class="num">${m.net_sales === null ? '–' : money(m.net_sales)}</td>`).join('')}<td class="num">${money(data.week_sales)}</td></tr>
          <tr><th>Labour %</th>${data.daily_money.map((m) => `<td class="num tone-${labourTone(m.labour_pct)}">${fmtPct(m.labour_pct)}</td>`).join('')}<td class="num tone-${labourTone(data.labour_pct)}">${fmtPct(data.labour_pct)}</td></tr>` : ''}` : ''}
        </tfoot>
      </table>
    </div>
    ${!data.staff.length ? `<div class="empty">No staff ${all ? 'yet' : 'at this location yet'}. Add them under Setup → Staff.</div>` : ''}
    ${coverAway.size ? '<p class="muted small">Greyed-out days: that person is covering at another site.</p>' : ''}
    ${byGroup && !data.staff.some((u) => u.rota_group) ? '<p class="muted small">Nobody has a role yet – set one for each person on the Staff page.</p>' : ''}
    ${fcNote ? `<p class="muted small">${fcNote}</p>` : ''}
    ${canEdit ? '<p class="muted small">You’re seeing the draft rota: hours and costs include changes that aren’t published yet. Hover over a marked shift to see what staff currently see.</p>' : ''}`;

  el.querySelector('#rota-layout')?.addEventListener('change', (e) => {
    try { localStorage.setItem(LAYOUT_KEY, e.target.value); } catch { /* storage unavailable */ }
    ctx.rerender();
  });
  el.querySelector('#rota-site')?.addEventListener('change', (e) => ctx.navigate(`rota${qs(view === 'day' ? { day, site: e.target.value } : { view: 'week', week, site: e.target.value })}`));
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === view) return;
    ctx.navigate(`rota${scopeQs(b.dataset.view === 'day' ? { view: undefined, day: week === weekStart(today) ? today : week } : { view: 'week', week: weekStart(day) })}`);
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
  el.querySelector('#print')?.addEventListener('click', () => window.print());
  if (!canEdit) return;

  const staffOptions = data.staff.map((u) => [u.id, all && u.location_name ? `${u.name} (${u.location_name})` : u.name]);
  // Admins can put anyone on at any site; managers only run their own site.
  // Any site this person can access (admins: every site).
  const siteOptions = state.locations.filter((l) => l.active).map((l) => [l.id, l.name]);
  const shiftModal = (shift, defaults = {}) => {
    const s = shift ?? { start_time: '07:00', end_time: '15:00', break_minutes: 30, ...defaults };
    const person = data.staff.find((u) => u.id === s.user_id);
    const site = s.location_id ?? (all ? person?.location_id : siteId) ?? state.locationId;
    const unpublished = shift && shift.state && shift.state !== 'published';
    const { form } = openModal({
      title: shift ? 'Edit shift' : 'Add shift',
      body: `
        ${unpublished ? `<p class="notice publish-one">${shift.state === 'new' ? 'Staff can’t see this shift yet.' : 'Staff still see the old version of this shift.'}
          ${data.can_publish ? '<button type="button" class="btn btn-small btn-primary" id="publish-one">Publish just this shift</button>' : ''}</p>` : ''}
        <div class="row">
          ${field('Staff member', select('user_id', staffOptions, s.user_id, 'required'))}
          ${field('Site', select('location_id', siteOptions, site, `required ${siteOptions.length > 1 ? '' : 'disabled'}`))}
        </div>
        ${field('Date', input('date', s.date, 'type="date" required'))}
        <p class="notice" id="avail-warn" hidden></p>
        <div class="row">
          ${field('Start', input('start_time', s.start_time, 'type="time" required'))}
          ${field('End', input('end_time', s.end_time, 'type="time" required'))}
          ${field('Unpaid break (mins)', input('break_minutes', s.break_minutes, 'type="number" min="0" step="5"'))}
        </div>
        <input type="hidden" name="position" value="${esc(s.position ?? person?.position ?? '')}">
        ${field('Notes', textarea('notes', s.notes))}
        ${shift ? '<details class="shift-history"><summary>History of this shift</summary><div id="shift-history" class="muted small">Loading…</div></details>' : ''}`,
      danger: shift ? 'Delete shift' : null,
      onDanger: async () => {
        await api(`/shifts/${shift.id}`, { method: 'DELETE' });
        toast(shift.state === 'new' ? 'Shift deleted' : 'Shift removed. Staff will stop seeing it once you publish.');
        ctx.rerender();
      },
      onSubmit: async (v) => {
        const body = { ...v, location_id: Number(v.location_id ?? site) };
        if (shift) await api(`/shifts/${shift.id}`, { method: 'PUT', body });
        else await api('/shifts', { method: 'POST', body });
        toast('Shift saved');
        ctx.rerender();
      },
    });
    // Warn (without blocking) when the shift is outside someone's usual availability or on a day they've asked off.
    const warn = form.querySelector('#avail-warn');
    const check = () => {
      const userId = Number(form.user_id.value);
      const d = form.date.value;
      const name = data.staff.find((u) => u.id === userId)?.name ?? 'They';
      const a = d ? availOn(userId, d) : null;
      let msg = '';
      if (d && holidayOn(userId, d, 'approved')) msg = `${name} is on holiday that day, so this shift can’t be saved.`;
      else if (d && holidayOn(userId, d, 'pending')) msg = `${name} has asked for holiday that day.`;
      else if (a?.status === 'none') msg = `${name} isn’t usually available on ${WEEKDAY_NAMES[weekdayOf(d)]}.`;
      else if (a?.status === 'some' && (form.start_time.value < a.from_time || form.end_time.value > a.to_time)) {
        msg = `${name} is usually only available ${a.from_time}–${a.to_time} on ${WEEKDAY_NAMES[weekdayOf(d)]}.`;
      }
      warn.textContent = msg;
      warn.hidden = !msg;
    };
    ['user_id', 'date', 'start_time', 'end_time'].forEach((n) => form[n].addEventListener('change', check));
    check();
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

  el.querySelectorAll('[data-person]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openStaffEditor(ctx, Number(b.dataset.person)).catch(showError);
  }));
  el.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const shift = data.shifts.find((s) => s.id === Number(b.dataset.shift));
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
  el.querySelectorAll('td.editable').forEach((td) => td.addEventListener('click', () => {
    shiftModal(null, { user_id: Number(td.dataset.user), date: td.dataset.date, location_id: Number(td.dataset.site) });
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
  el.querySelector('#discard')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Throw away every unpublished change this week? New shifts are deleted, changed ones go back to what staff can see, and removed ones come back.', { confirmLabel: 'Discard changes', title: 'Discard changes' }))) return;
    try {
      const r = await api('/rota/discard', { method: 'POST', body: scopeBody });
      toast(`Discarded ${r.discarded} change${r.discarded === 1 ? '' : 's'}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
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
              <div class="my-time">${s.start_time}–${s.end_time}</div>
              <div class="my-where">${esc(s.location_name)}<small>${hrs(s.hours)}${s.break_minutes ? ` · ${s.break_minutes} min break` : ''}${s.notes ? ` · ${esc(s.notes)}` : ''}</small></div>
              ${s.colleagues ? `<div class="my-with small muted">${s.colleagues.length ? `With ${s.colleagues.map((c) => `${esc(c.name)} <span class="nowrap">${c.start_time}–${c.end_time}</span>`).join(', ')}` : 'Nobody else on'}</div>` : ''}
            </div>`).join('') : '<span class="muted">Day off</span>'}</div>
        </div>`;
      }).join('')}
    </section>
    <p class="muted small">These are your published shifts. If something looks wrong, speak to your manager.</p>`;

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const offset = Number(b.dataset.week);
    ctx.navigate(`rota${qs({ view: 'mine', week: offset ? addDays(week, offset) : undefined })}`);
  }));
  el.querySelector('#print').addEventListener('click', () => window.print());
}
