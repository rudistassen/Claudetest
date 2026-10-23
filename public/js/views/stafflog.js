import { saveFile, workbook } from '../excel.js';
import { addDays, api, esc, qs, showError, todayISO } from '../lib.js';

// Setup → Staff log: who signed in (and failed sign-ins), and every change people made, newest first.

const KIND_ICON = { sign_in: '🔑', sign_in_failed: '⛔', sign_out: '👋', password: '🔒', change: '✎' };
// Times are saved in UTC; shown in UK time.
const when = (sqlUtc) => new Date(`${sqlUtc.replace(' ', 'T')}Z`);
const dayLabel = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const timeLabel = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

export async function render(ctx) {
  const { el, query, stale, navigate } = ctx;
  const filters = {
    user_id: query.user_id ?? '',
    kind: query.kind ?? '',
    area: query.area ?? '',
    from: query.from ?? addDays(todayISO(), -6),
    to: query.to ?? todayISO(),
  };
  const data = await api(`/staff-log${qs(filters)}`);
  if (stale()) return;
  let rows = data.rows;
  let more = data.more;

  const rowHtml = (r) => {
    const d = when(r.created_at);
    return `<li class="sl-row sl-${r.kind}">
      <span class="sl-time">${timeLabel(d)}</span>
      <span class="sl-icon" aria-hidden="true">${KIND_ICON[r.kind] ?? '✎'}</span>
      <span class="sl-main"><strong>${esc(r.user_name ?? 'Unknown')}</strong> ${esc(r.action.charAt(0).toLowerCase() + r.action.slice(1))}${r.times > 1 ? ` <span class="sl-times">×${r.times}</span>` : ''}
        ${r.detail ? `<small class="sl-detail">${esc(r.detail)}</small>` : ''}
        <small class="muted">${esc([r.area, r.location_name, r.device, r.ip].filter(Boolean).join(' · '))}</small></span>
    </li>`;
  };
  const listHtml = () => {
    if (!rows.length) return '<div class="card empty">Nothing logged for these filters.</div>';
    const days = [];
    for (const r of rows) {
      const label = dayLabel(when(r.created_at));
      if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
      days.at(-1).rows.push(r);
    }
    return days.map((g) => `<section class="sl-day"><h2 class="sl-day-head">${esc(g.label)}</h2><ul class="sl-list">${g.rows.map(rowHtml).join('')}</ul></section>`).join('')
      + (more ? '<p class="sl-more"><button type="button" class="btn" id="sl-more">Show older</button></p>' : '');
  };

  el.innerHTML = `<div class="hip">
    <div class="page-head"><h1 class="hub-title">Staff log</h1>
      <div class="actions"><button type="button" class="btn" id="sl-export">Export to Excel</button></div></div>
    <p class="muted">Every sign-in (including failed ones) and every change people make in Atlas. Kept for a year.</p>
    <form class="card sl-filters" id="sl-filters">
      <label>Person<select name="user_id"><option value="">Everyone</option>${data.people.map((p) => `<option value="${p.id}" ${String(p.id) === String(filters.user_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Show<select name="kind">
        <option value="" ${!filters.kind ? 'selected' : ''}>Everything</option>
        <option value="sign_ins" ${filters.kind === 'sign_ins' ? 'selected' : ''}>Sign-ins only</option>
        <option value="changes" ${filters.kind === 'changes' ? 'selected' : ''}>Changes only</option></select></label>
      <label>Area<select name="area"><option value="">All areas</option>${data.areas.map((a) => `<option ${a === filters.area ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label>From<input type="date" name="from" value="${esc(filters.from)}" max="${todayISO()}"></label>
      <label>To<input type="date" name="to" value="${esc(filters.to)}" max="${todayISO()}"></label>
    </form>
    <div id="sl-list">${listHtml()}</div></div>`;

  const form = el.querySelector('#sl-filters');
  form.addEventListener('change', () => {
    const v = Object.fromEntries(new FormData(form));
    navigate(`admin/staff-log${qs(Object.fromEntries(Object.entries(v).filter(([, x]) => x)))}`);
  });
  const wireMore = () => el.querySelector('#sl-more')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const next = await api(`/staff-log${qs({ ...filters, before: rows.at(-1).id })}`);
      rows = rows.concat(next.rows);
      more = next.more;
      el.querySelector('#sl-list').innerHTML = listHtml();
      wireMore();
    } catch (err) { showError(err); e.target.disabled = false; }
  });
  wireMore();

  el.querySelector('#sl-export').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      // Everything matching the filters, a page at a time.
      let all = rows.slice();
      let left = more;
      while (left && all.length < 20000) {
        const next = await api(`/staff-log${qs({ ...filters, before: all.at(-1).id })}`);
        all = all.concat(next.rows);
        left = next.more;
      }
      const head = ['Date', 'Time', 'Person', 'Site', 'What they did', 'Details', 'Times', 'Area', 'Device', 'IP address'].map((v) => ({ v, bold: true }));
      const body = all.map((r) => {
        const d = when(r.created_at);
        return [d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }), timeLabel(d), r.user_name ?? '', r.location_name ?? '', r.action, r.detail ?? '', r.times, r.area ?? '', r.device ?? '', r.ip ?? ''];
      });
      saveFile(`Staff log ${filters.from} to ${filters.to}.xlsx`, workbook('Staff log', [head, ...body], [12, 8, 22, 18, 36, 40, 7, 14, 20, 16]));
    } catch (err) { showError(err); }
    e.target.disabled = false;
  });
}
