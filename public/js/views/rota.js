import { addDays, api, confirmDialog, esc, field, fmtDate, input, money, openModal, qs, select, showError, textarea, toast, todayISO, weekStart } from '../lib.js';

const POSITIONS = ['Manager', 'Supervisor', 'Barista', 'Kitchen', 'Front of house', 'Cleaner'];

export async function render(ctx) {
  const { el, state, query, stale } = ctx;
  const week = weekStart(query.week || todayISO());
  const data = await api(`/rota${qs({ location_id: state.locationId, week })}`);
  if (stale()) return;
  const canEdit = state.isManager;
  const today = todayISO();

  const byCell = new Map();
  for (const s of data.shifts) {
    const k = `${s.user_id}|${s.date}`;
    byCell.set(k, [...(byCell.get(k) ?? []), s]);
  }
  const dayHours = data.days.map((d) => data.shifts.filter((s) => s.date === d).reduce((t, s) => t + s.hours, 0));

  el.innerHTML = `
    <div class="page-head">
      <h1>Rota · ${esc(state.location?.name ?? '')}</h1>
      <div class="actions">
        <button class="btn" data-week="-7">‹ Prev</button>
        <button class="btn" data-week="0">This week</button>
        <button class="btn" data-week="7">Next ›</button>
        ${canEdit ? '<button class="btn" id="copy-week">Copy previous week</button>' : ''}
        <button class="btn" id="print">Print</button>
      </div>
    </div>
    <p class="muted">Week commencing ${fmtDate(week, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      · ${data.total_hours} hours${data.labour_cost !== undefined ? ` · labour cost ${money(data.labour_cost)}` : ''}</p>
    <div class="table-wrap">
      <table class="rota">
        <thead><tr><th>Staff</th>${data.days.map((d) => `<th class="${d === today ? 'is-today' : ''}">${fmtDate(d)}</th>`).join('')}<th>Hours</th></tr></thead>
        <tbody>
          ${data.staff.map((u) => `
            <tr>
              <th><strong>${esc(u.name)}</strong><small>${esc(u.position ?? '')}${u.location_id !== state.locationId ? ' · cover' : ''}</small></th>
              ${data.days.map((d) => {
                const shifts = byCell.get(`${u.id}|${d}`) ?? [];
                return `<td class="${d === today ? 'is-today' : ''} ${canEdit ? 'editable' : ''}" data-user="${u.id}" data-date="${d}">
                  ${shifts.map((s) => `<button class="shift" data-shift="${s.id}" ${canEdit ? '' : 'disabled'}>
                    ${s.start_time}–${s.end_time}${s.position && s.position !== u.position ? `<small>${esc(s.position)}</small>` : ''}</button>`).join('')}
                  ${canEdit && !shifts.length ? '<span class="add-hint">+</span>' : ''}
                </td>`;
              }).join('')}
              <td class="num">${data.hours_by_user[u.id] ?? 0}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr><th>Total hours</th>${dayHours.map((h) => `<td class="num">${Math.round(h * 100) / 100}</td>`).join('')}<td class="num"><strong>${data.total_hours}</strong></td></tr></tfoot>
      </table>
    </div>
    ${!data.staff.length ? '<div class="empty">No staff at this location yet. Add them under Setup → Staff.</div>' : ''}`;

  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const offset = Number(b.dataset.week);
    ctx.navigate(`rota${offset ? `?week=${addDays(week, offset)}` : ''}`);
  }));
  el.querySelector('#print').addEventListener('click', () => window.print());
  if (!canEdit) return;

  const staffOptions = data.staff.map((u) => [u.id, u.name]);
  const shiftModal = (shift, defaults = {}) => {
    const s = shift ?? { start_time: '07:00', end_time: '15:00', break_minutes: 30, ...defaults };
    const person = data.staff.find((u) => u.id === s.user_id);
    openModal({
      title: shift ? 'Edit shift' : 'Add shift',
      body: `
        ${field('Staff member', select('user_id', staffOptions, s.user_id, 'required'))}
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
        const body = { ...v, location_id: state.locationId };
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
  el.querySelectorAll('td.editable').forEach((td) => td.addEventListener('click', () => {
    shiftModal(null, { user_id: Number(td.dataset.user), date: td.dataset.date });
  }));
  el.querySelector('#copy-week').addEventListener('click', async () => {
    const hasShifts = data.shifts.length > 0;
    if (!(await confirmDialog(
      hasShifts
        ? 'Copy last week’s shifts into this week? Existing shifts stay; anything that would double-book someone is skipped.'
        : 'Copy last week’s shifts into this week?',
      { confirmLabel: 'Copy shifts', title: 'Copy previous week' },
    ))) return;
    try {
      const r = await api('/rota/copy-week', { method: 'POST', body: { location_id: state.locationId, from_week: addDays(week, -7), to_week: week } });
      toast(`Copied ${r.copied} shift(s)${r.skipped ? `, skipped ${r.skipped} clash(es)` : ''}`);
      ctx.rerender();
    } catch (err) { showError(err); }
  });
}
