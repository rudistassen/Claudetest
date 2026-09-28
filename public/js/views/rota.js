import { fmtPct, labourTone } from './sales.js';
import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, select, showError, textarea, toast, todayISO, weekStart } from '../lib.js';

const POSITIONS = ['Manager', 'Supervisor', 'Barista', 'Kitchen', 'Front of house', 'Cleaner'];

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const week = weekStart(query.week || todayISO());
  // Admins can see every site's rota at once.
  const all = state.isAdmin && query.scope === 'all';
  const scopeQs = (extra = {}) => qs({ ...extra, scope: all ? 'all' : undefined });
  const data = await api(`/rota${qs({ location_id: all ? 'all' : state.locationId, week })}`);
  if (stale()) return;
  const canEdit = state.isManager;
  const today = todayISO();
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';

  // Cells are keyed by person, site and day. On All sites each site has its own group of rows: everyone rostered
  // there that week, plus that site's own staff so they can be added. Someone working at two sites is in both.
  const cellKey = (userId, siteId, d) => `${userId}|${all ? siteId : ''}|${d}`;
  const byCell = new Map();
  for (const s of [...data.shifts, ...data.away_shifts.map((a) => ({ ...a, away: true }))]) {
    const k = cellKey(s.user_id, s.location_id, s.date);
    byCell.set(k, [...(byCell.get(k) ?? []), s]);
  }
  for (const list of byCell.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
  const rows = [];
  if (all) {
    const sites = state.locations.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name));
    for (const site of sites) {
      const working = new Set(data.shifts.filter((x) => x.location_id === site.id).map((x) => x.user_id));
      const people = data.staff.filter((u) => u.location_id === site.id || working.has(u.id));
      if (!people.length) continue;
      rows.push({ header: site.name });
      // The site's own staff first, then people covering from elsewhere.
      for (const u of [...people.filter((p) => p.location_id === site.id), ...people.filter((p) => p.location_id !== site.id)]) {
        rows.push({ u, site: site.id });
      }
    }
  } else {
    for (const u of data.staff) rows.push({ u, site: state.locationId });
  }
  const rowHours = (u, site) => Math.round(data.shifts.filter((x) => x.user_id === u.id && (!all || x.location_id === site)).reduce((t, x) => t + x.hours, 0) * 100) / 100;
  // A shift at another site (greyed out on a single site's rota) says where it is.
  const shiftLabel = (s, u, site) => {
    const where = s.location_id !== site ? `@ ${s.location_name}` : '';
    const role = s.position && s.position !== u.position ? s.position : '';
    const sub = [where, role].filter(Boolean).join(' · ');
    return `${s.start_time}–${s.end_time}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  };
  const dayHours = data.days.map((d) => data.shifts.filter((s) => s.date === d).reduce((t, s) => t + s.hours, 0));

  el.innerHTML = `
    <div class="page-head">
      <h1>Rota · ${all ? 'All sites' : esc(state.location?.name ?? '')}</h1>
      <div class="actions">
        ${state.isAdmin ? `<a class="btn" href="#/rota${all ? qs({ week }) : qs({ week, scope: 'all' })}">${all ? 'This site only' : 'All sites'}</a>` : ''}
        <button class="btn" data-week="-7">‹ Prev</button>
        <button class="btn" data-week="0">This week</button>
        <button class="btn" data-week="7">Next ›</button>
        ${canEdit ? '<button class="btn" id="copy-week">Copy previous week</button>' : ''}
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    <p class="muted">Week commencing ${fmtDate(week, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      · ${data.total_hours} hours${data.labour_cost !== undefined ? ` · labour cost ${money(data.labour_cost)}` : ''}
      ${data.week_sales ? ` · sales to date ${money(data.week_sales)} · labour <span class="tone-${labourTone(data.labour_pct)}">${fmtPct(data.labour_pct)}</span> of sales to date` : ''}</p>
    <div class="table-wrap">
      <table class="rota">
        <thead><tr><th>Staff</th>${data.days.map((d) => `<th class="${d === today ? 'is-today' : ''}">${fmtDate(d)}</th>`).join('')}<th>Hours</th></tr></thead>
        <tbody>
          ${rows.map(({ header, u, site }) => (header ? `<tr class="rota-group"><th colspan="${data.days.length + 2}">${esc(header)}</th></tr>` : `
            <tr class="${u.location_id !== site ? 'rota-cover' : ''}">
              <th><strong>${esc(u.name)}</strong><small>${esc(u.position ?? '')}${u.location_id !== site ? ` · cover${u.location_name ? ` from ${esc(u.location_name)}` : ''}` : ''}</small></th>
              ${data.days.map((d) => {
                const shifts = byCell.get(cellKey(u.id, site, d)) ?? [];
                return `<td class="${d === today ? 'is-today' : ''} ${canEdit ? 'editable' : ''}" data-user="${u.id}" data-date="${d}" data-site="${site}">
                  ${shifts.map((s) => (s.away
                    ? `<span class="shift shift-away" title="Working at ${esc(s.location_name)}">${shiftLabel(s, u, site)}</span>`
                    : `<button class="shift" data-shift="${s.id}" ${canEdit ? '' : 'disabled'}>${shiftLabel(s, u, site)}</button>`)).join('')}
                  ${canEdit && !shifts.length ? '<span class="add-hint">+</span>' : ''}
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
    ${data.away_shifts.length ? '<p class="muted small">Greyed-out shifts are at another site.</p>' : ''}`;

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const offset = Number(b.dataset.week);
    ctx.navigate(`rota${scopeQs({ week: offset ? addDays(week, offset) : undefined })}`);
  }));
  el.querySelector('#print').addEventListener('click', () => window.print());
  if (!canEdit) return;

  const staffOptions = data.staff.map((u) => [u.id, all && u.location_name ? `${u.name} (${u.location_name})` : u.name]);
  // Admins can put anyone on at any site; managers only run their own site.
  const siteOptions = state.isAdmin
    ? state.locations.filter((l) => l.active).map((l) => [l.id, l.name])
    : [[state.user.location_id, siteName(state.user.location_id)]];
  const shiftModal = (shift, defaults = {}) => {
    const s = shift ?? { start_time: '07:00', end_time: '15:00', break_minutes: 30, ...defaults };
    const person = data.staff.find((u) => u.id === s.user_id);
    const site = s.location_id ?? (all ? person?.location_id : state.locationId) ?? state.locationId;
    openModal({
      title: shift ? 'Edit shift' : 'Add shift',
      body: `
        <div class="row">
          ${field('Staff member', select('user_id', staffOptions, s.user_id, 'required'))}
          ${field('Site', select('location_id', siteOptions, site, `required ${siteOptions.length > 1 ? '' : 'disabled'}`))}
        </div>
        ${field('Date', input('date', s.date, 'type="date" required'))}
        <div class="row">
          ${field('Start', input('start_time', s.start_time, 'type="time" required'))}
          ${field('End', input('end_time', s.end_time, 'type="time" required'))}
          ${field('Unpaid break (mins)', input('break_minutes', s.break_minutes, 'type="number" min="0" step="5"'))}
        </div>
        ${field('Role on shift', select('position', [['', '—'], ...POSITIONS.map((p) => [p, p])], s.position ?? person?.position ?? ''))}
        ${field('Notes', textarea('notes', s.notes))}`,
      danger: shift ? 'Delete shift' : null,
      onDanger: async () => {
        await api(`/shifts/${shift.id}`, { method: 'DELETE' });
        toast('Shift deleted');
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
  };

  el.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    shiftModal(data.shifts.find((s) => s.id === Number(b.dataset.shift)));
  }));
  // Shifts at another site are edited from that site's rota (or All sites).
  el.querySelectorAll('.shift-away').forEach((a) => a.addEventListener('click', (e) => {
    e.stopPropagation();
    toast(`${a.title}. Edit it from that site’s rota${state.isAdmin ? ' or All sites' : ''}.`);
  }));
  el.querySelectorAll('td.editable').forEach((td) => td.addEventListener('click', () => {
    shiftModal(null, { user_id: Number(td.dataset.user), date: td.dataset.date, location_id: Number(td.dataset.site) });
  }));
  el.querySelector('#copy-week').addEventListener('click', async () => {
    const hasShifts = data.shifts.length > 0;
    if (!(await confirmDialog(
      hasShifts
        ? `Copy last week’s shifts${all ? ' at every site' : ''} into this week? Existing shifts stay; anything that would double-book someone is skipped.`
        : `Copy last week’s shifts${all ? ' at every site' : ''} into this week?`,
      { confirmLabel: 'Copy shifts', title: 'Copy previous week' },
    ))) return;
    try {
      const r = await api('/rota/copy-week', { method: 'POST', body: { location_id: all ? 'all' : state.locationId, from_week: addDays(week, -7), to_week: week } });
      toast(`Copied ${r.copied} shift(s)${r.skipped ? `, skipped ${r.skipped} clash(es)` : ''}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
}
