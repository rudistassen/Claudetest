import { api, esc, field, fmtDate, openModal, showError, siteColour, textarea, toast } from '../lib.js';
import { dropsPanel, wireDrops } from './shiftdrops.js';

// Rota → Requests: everything waiting for a manager in one place – holiday requests and shift drop requests.

const day = (d) => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
const span = (r) => (r.start_date === r.end_date ? day(r.start_date) : `${day(r.start_date)} – ${day(r.end_date)}`);

export async function render(ctx) {
  const { el, state, stale, rerender } = ctx;
  const canLeave = state.can('leave.manage');
  const canDrops = state.can('rota.publish');
  const [leave, drops] = await Promise.all([
    canLeave ? api('/leave?status=pending') : Promise.resolve([]),
    canDrops ? api('/shift-drops') : Promise.resolve({ open: [], to_approve: [], mine: [] }),
  ]);
  if (stale()) return;
  const total = leave.length + drops.to_approve.length;

  el.innerHTML = `
    <div class="page-head"><h1>Requests</h1></div>
    <p class="muted">${total ? `<strong>${total}</strong> request${total === 1 ? '' : 's'} waiting for you.` : 'Nothing waiting – you’re all caught up.'}</p>
    ${canLeave ? `<section class="card req-section">
      <h2>Holiday <span class="badge ${leave.length ? 'badge-sent' : ''}">${leave.length}</span></h2>
      ${leave.length ? `<ul class="drops-list">${leave.map((r) => `<li>
        <div><strong>${esc(r.user_name)}</strong> · ${esc(span(r))} <span class="muted">(${r.days} day${r.days === 1 ? '' : 's'})</span>
          <small>${r.location_name ? `<span class="site-dot" style="--site: ${siteColour(r.location_name, r.location_id)}"></span>${esc(r.location_name)}` : ''}${r.note ? ` · “${esc(r.note)}”` : ''}</small>
          ${r.shifts?.length ? `<small class="tone-bad">⚠ On the rota ${r.shifts.length} time${r.shifts.length === 1 ? '' : 's'} then: ${r.shifts.slice(0, 3).map((s) => `${day(s.date)} ${s.start_time}–${s.end_time}`).join(', ')}${r.shifts.length > 3 ? '…' : ''}</small>` : ''}</div>
        <div class="drops-actions"><button class="btn btn-small btn-primary" data-leave-approve="${r.id}">Approve</button>
          <button class="btn btn-small" data-leave-decline="${r.id}">Decline</button></div></li>`).join('')}</ul>`
        : '<p class="muted small">No holiday requests waiting.</p>'}
      <p class="small"><a href="#/timeoff">All holiday and availability →</a></p>
    </section>` : ''}
    ${canDrops ? `<section class="req-section">
      ${drops.to_approve.length ? dropsPanel({ ...drops, open: [], mine: [] }) : '<section class="card"><h2>Shift drop requests <span class="badge">0</span></h2><p class="muted small">No shifts waiting to be dropped.</p></section>'}
      ${drops.open.length ? `<p class="small muted">${drops.open.length} open shift${drops.open.length === 1 ? '' : 's'} waiting for someone to pick up – see the rota.</p>` : ''}
    </section>` : ''}`;

  wireDrops(el, drops, () => { window.dispatchEvent(new Event('requests:changed')); rerender(); });
  el.querySelectorAll('[data-leave-approve]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/leave/${b.dataset.leaveApprove}/decide`, { method: 'POST', body: { status: 'approved' } });
      toast(`Holiday approved for ${r.user_name}`);
      window.dispatchEvent(new Event('requests:changed'));
      rerender();
    } catch (err) { showError(err); b.disabled = false; }
  }));
  el.querySelectorAll('[data-leave-decline]').forEach((b) => b.addEventListener('click', () => {
    const r = leave.find((x) => x.id === Number(b.dataset.leaveDecline));
    openModal({
      title: `Decline ${r.user_name}’s holiday?`,
      body: `<p>${esc(span(r))}</p>${field('Note for them (optional)', textarea('note', '', 'maxlength="500"'))}`,
      submitLabel: 'Decline',
      onSubmit: async (v) => {
        await api(`/leave/${r.id}/decide`, { method: 'POST', body: { status: 'declined', note: v.note } });
        toast('Declined');
        window.dispatchEvent(new Event('requests:changed'));
        rerender();
      },
    });
  }));
}
