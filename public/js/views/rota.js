import { fmtPct, labourTone } from './sales.js';
import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, select, showError, textarea, toast, todayISO, weekStart } from '../lib.js';

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const week = weekStart(query.week || todayISO());
  if (query.view === 'mine') return renderMine(ctx, week);
  // People with more than one site can see every site's rota at once.
  // Which site: ?site=all or a site id. People with several sites start on All sites; the old ?scope= links still work.
  const active = state.locations.filter((l) => l.active);
  const asked = query.site ?? (query.scope === 'site' ? String(state.locationId) : query.scope === 'all' ? 'all' : null);
  const all = state.multiSite && (asked ?? 'all') === 'all';
  const siteId = all ? null : (active.find((l) => String(l.id) === asked)?.id ?? state.locationId);
  if (siteId && siteId !== state.locationId) {
    // Keep the site in the top bar in step with the one picked here.
    state.locationId = siteId;
    try { localStorage.setItem('cafe-ops:location', String(siteId)); } catch { /* storage unavailable */ }
    const name = document.querySelector('.site-btn-name');
    if (name) name.textContent = active.find((l) => l.id === siteId)?.name ?? '';
    document.querySelectorAll('#site-menu li').forEach((li) => {
      const on = Number(li.dataset.siteId) === siteId;
      li.setAttribute('aria-selected', String(on));
      li.querySelector('.site-tick').textContent = on ? '✓' : '';
    });
  }
  const siteParam = all ? 'all' : String(siteId);
  const scopeQs = (extra = {}) => qs({ ...extra, site: state.multiSite ? siteParam : undefined });
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
  // "Group by rota group": sub-headings for each group (Kitchen, Front of house…), remembered on this device.
  const BY_GROUP_KEY = 'cafe-ops:rota-by-group';
  let byGroup = false;
  try { byGroup = localStorage.getItem(BY_GROUP_KEY) === '1'; } catch { /* storage unavailable */ }
  const hoursAt = (u, site) => counted.filter((x) => x.user_id === u.id && (!all || x.location_id === site)).reduce((t, x) => t + x.hours, 0);
  const withGroups = (people, site) => {
    if (!byGroup) return people.map((u) => ({ u, site }));
    const names = [...new Set(people.map((u) => u.rota_group ?? ''))]
      .sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
    return names.flatMap((name) => {
      const inGroup = people.filter((u) => (u.rota_group ?? '') === name);
      return [
        { sub: name || 'No rota group', site, people: inGroup.length, hours: Math.round(inGroup.reduce((t, u) => t + hoursAt(u, site), 0) * 10) / 10 },
        ...inGroup.map((u) => ({ u, site })),
      ];
    });
  };
  const rows = [];
  if (all) {
    const sites = state.locations.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name));
    for (const site of sites) {
      const working = new Set(data.shifts.filter((x) => x.location_id === site.id).map((x) => x.user_id));
      const people = data.staff.filter((u) => u.location_id === site.id || working.has(u.id));
      if (!people.length) continue;
      const siteShifts = counted.filter((x) => x.location_id === site.id);
      const rate = new Map(data.staff.map((u) => [u.id, u.hourly_rate]));
      rows.push({
        header: site.name,
        siteId: site.id,
        summary: {
          people: people.length,
          hours: Math.round(siteShifts.reduce((t, x) => t + x.hours, 0) * 10) / 10,
          // Pay rates are only sent to managers and admins.
          cost: data.labour_cost !== undefined ? siteShifts.reduce((t, x) => t + x.hours * (rate.get(x.user_id) ?? 0), 0) : null,
        },
      });
      // The site's own staff first, then people covering from elsewhere.
      rows.push(...withGroups([...people.filter((p) => p.location_id === site.id), ...people.filter((p) => p.location_id !== site.id)], site.id));
    }
  } else {
    rows.push(...withGroups(data.staff, siteId));
  }
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

  el.innerHTML = `
    <div class="page-head">
      <h1>Rota · ${all ? 'All sites' : esc(state.location?.name ?? '')}</h1>
      <div class="actions">
        ${state.multiSite ? `<select id="rota-site" aria-label="Site">
          <option value="all" ${all ? 'selected' : ''}>All sites</option>
          ${active.map((l) => `<option value="${l.id}" ${l.id === siteId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>` : ''}
        <button class="btn ${byGroup ? 'is-on' : ''}" id="by-group" aria-pressed="${byGroup}" title="Show sub-headings for each rota group (set on the Staff page)">Group by rota group</button>
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
    <div class="table-wrap">
      <table class="rota">
        <thead><tr><th>Staff</th>${data.days.map((d) => `<th class="${d === today ? 'is-today' : ''}">${fmtDate(d)}</th>`).join('')}<th>Hours</th></tr></thead>
        <tbody>
          ${rows.map(({ header, siteId: groupId, summary, u, site, sub, people: subPeople, hours: subHours }) => (sub !== undefined ? `<tr class="rota-subgroup" ${all ? `data-in-group="${site}"` : ''}>
            <th colspan="${data.days.length + 2}"><span class="rota-subgroup-name">${esc(sub)}</span>
              <span class="rota-group-meta">${subPeople} ${subPeople === 1 ? 'person' : 'people'} · ${subHours} h</span></th></tr>` : header ? `<tr class="rota-group" data-group="${groupId}"><th colspan="${data.days.length + 2}">
            <button class="rota-group-toggle" aria-expanded="true" data-toggle="${groupId}">
              <span class="rota-chevron" aria-hidden="true">▾</span>
              <span class="rota-group-name">${esc(header)}</span>
              <span class="rota-group-meta">${summary.people} ${summary.people === 1 ? 'person' : 'people'} · ${summary.hours} h${summary.cost === null ? '' : ` · ${money(summary.cost)} labour`}</span>
            </button>
          </th></tr>` : `
            <tr class="${u.location_id !== site ? 'rota-cover' : ''}" ${all ? `data-in-group="${site}"` : ''}>
              <th><strong>${esc(u.name)}</strong>${u.location_id !== site ? `<small>cover${u.location_name ? ` from ${esc(u.location_name)}` : ''}</small>` : ''}</th>
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
          ${data.daily_money.some((m) => m.net_sales !== null) ? `
          <tr><th>Sales (Square)</th>${data.daily_money.map((m) => `<td class="num">${m.net_sales === null ? '–' : money(m.net_sales)}</td>`).join('')}<td class="num">${money(data.week_sales)}</td></tr>
          <tr><th>Labour %</th>${data.daily_money.map((m) => `<td class="num tone-${labourTone(m.labour_pct)}">${fmtPct(m.labour_pct)}</td>`).join('')}<td class="num tone-${labourTone(data.labour_pct)}">${fmtPct(data.labour_pct)}</td></tr>` : ''}` : ''}
        </tfoot>
      </table>
    </div>
    ${!data.staff.length ? `<div class="empty">No staff ${all ? 'yet' : 'at this location yet'}. Add them under Setup → Staff.</div>` : ''}
    ${coverAway.size ? '<p class="muted small">Greyed-out days: that person is covering at another site.</p>' : ''}
    ${byGroup && !data.staff.some((u) => u.rota_group) ? '<p class="muted small">Nobody has a rota group yet – set one for each person on the Staff page.</p>' : ''}
    ${canEdit ? '<p class="muted small">You’re seeing the draft rota: hours and costs include changes that aren’t published yet. Hover over a marked shift to see what staff currently see.</p>' : ''}`;

  el.querySelector('#by-group').addEventListener('click', () => {
    try { localStorage.setItem(BY_GROUP_KEY, byGroup ? '0' : '1'); } catch { /* storage unavailable */ }
    ctx.rerender();
  });
  el.querySelector('#rota-site')?.addEventListener('change', (e) => ctx.navigate(`rota${qs({ week, site: e.target.value })}`));

  // Folding sites away on All sites. Which are folded is remembered in this browser.
  const FOLD_KEY = 'cafe-ops:rota-collapsed';
  let folded = new Set();
  try { folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]')); } catch { /* storage unavailable */ }
  const groups = [...el.querySelectorAll('tr.rota-group')].map((g) => g.dataset.group);
  const applyFolds = () => {
    for (const g of groups) {
      const shut = folded.has(g);
      el.querySelectorAll(`tr[data-in-group="${g}"]`).forEach((tr) => { tr.hidden = shut; });
      const btn = el.querySelector(`[data-toggle="${g}"]`);
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
  el.querySelector('#print').addEventListener('click', () => window.print());
  if (!canEdit) return;

  const staffOptions = data.staff.map((u) => [u.id, all && u.location_name ? `${u.name} (${u.location_name})` : u.name]);
  // Admins can put anyone on at any site; managers only run their own site.
  // Any site this person can access (admins: every site).
  const siteOptions = state.locations.filter((l) => l.active).map((l) => [l.id, l.name]);
  const shiftModal = (shift, defaults = {}) => {
    const s = shift ?? { start_time: '07:00', end_time: '15:00', break_minutes: 30, ...defaults };
    const person = data.staff.find((u) => u.id === s.user_id);
    const site = s.location_id ?? (all ? person?.location_id : siteId) ?? state.locationId;
    const { form } = openModal({
      title: shift ? 'Edit shift' : 'Add shift',
      body: `
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
        ${field('Notes', textarea('notes', s.notes))}`,
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
  };

  el.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const shift = data.shifts.find((s) => s.id === Number(b.dataset.shift));
    if (shift.state === 'removed') {
      confirmDialog(`Put back ${shift.user_name}’s ${shift.start_time}–${shift.end_time} shift on ${fmtDate(shift.date)}?`, { confirmLabel: 'Put it back', title: 'Removed shift' })
        .then(async (ok) => {
          if (!ok) return;
          try {
            await api(`/shifts/${shift.id}/restore`, { method: 'POST' });
            toast('Shift put back');
            ctx.rerender();
          } catch (err) { showError(err); }
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
  const scopeBody = { location_id: all ? 'all' : siteId, week };
  el.querySelector('#publish')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Publish ${pending} change${pending === 1 ? '' : 's'}${all ? ' across every site' : ''}? Staff will see the rota as it is now.`, { confirmLabel: 'Publish', title: 'Publish rota' }))) return;
    try {
      const r = await api('/rota/publish', { method: 'POST', body: scopeBody });
      toast(`Published ${r.published} change${r.published === 1 ? '' : 's'}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
  el.querySelector('#discard')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Throw away every unpublished change this week? New shifts are deleted, changed ones go back to what staff can see, and removed ones come back.', { confirmLabel: 'Discard changes', title: 'Discard changes' }))) return;
    try {
      const r = await api('/rota/discard', { method: 'POST', body: scopeBody });
      toast(`Discarded ${r.discarded} change${r.discarded === 1 ? '' : 's'}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
  el.querySelector('#copy-week').addEventListener('click', async () => {
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
