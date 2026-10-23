import { api, esc, field, fmtDate, openModal, showError, siteColour, textarea, toast, todayISO } from '../lib.js';

// Swapping shifts: ask a colleague to swap one of your shifts (for one of theirs, or for them to cover it), answer
// swaps asked of you, and – for managers – approve or decline swaps both people have agreed.

const when = (s) => `${s.date === todayISO() ? 'Today' : fmtDate(s.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${s.start_time}–${s.end_time}`;
const site = (s) => `<span class="site-dot" style="--site: ${siteColour(s.location_name ?? '', s.location_id)}"></span>${esc(s.location_name ?? '')}`;
const STATUS = {
  asked: ['Waiting for them to agree', 'badge-sent'],
  pending: ['Agreed – waiting for a manager', 'badge-in_progress'],
  approved: ['Approved ✓', 'badge-received'],
  refused: ['They said no', 'badge-cancelled'],
  declined: ['Declined by a manager', 'badge-cancelled'],
};
const badge = (w, me = 'from') => `<span class="badge ${STATUS[w.status]?.[1] ?? ''}">${w.status === 'asked' && me === 'to' ? 'Waiting for you to answer' : w.status === 'refused' && me === 'to' ? 'You said no' : STATUS[w.status]?.[0] ?? esc(w.status)}</span>`;
const what = (w, me) => (w.take
  ? (me === 'from' ? `Your <strong>${esc(when(w.give))}</strong> for ${esc(w.to_name)}’s <strong>${esc(when(w.take))}</strong>`
    : me === 'to' ? `${esc(w.from_name)}’s <strong>${esc(when(w.give))}</strong> for your <strong>${esc(when(w.take))}</strong>`
      : `${esc(w.from_name)}’s <strong>${esc(when(w.give))}</strong> ⇄ ${esc(w.to_name)}’s <strong>${esc(when(w.take))}</strong>`)
  : (me === 'from' ? `${esc(w.to_name)} to cover your <strong>${esc(when(w.give))}</strong>`
    : me === 'to' ? `Cover ${esc(w.from_name)}’s <strong>${esc(when(w.give))}</strong>`
      : `${esc(w.to_name)} to cover ${esc(w.from_name)}’s <strong>${esc(when(w.give))}</strong>`));
const where = (w) => `${site(w.give)}${w.take && w.take.location_id !== w.give.location_id ? ` · ${site(w.take)}` : ''}`;

const personLabel = (p) => `${esc(p.name)}${p.location_name ? ` – ${esc(p.location_name)}` : ''}`;
const searchable = (form) => form.querySelector('.swap-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  [...form.querySelector('.swap-people').options].forEach((o) => { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); });
});

/** Ask a colleague to swap one of your shifts for one of theirs (s: a shift from /my-shifts). */
export async function askToSwap(s, done) {
  let opts;
  try { opts = await api(`/swaps/options?shift_id=${s.id}`); } catch (err) { showError(err); return; }
  const people = opts.people.filter((p) => p.shifts.length);
  if (!people.length) { toast('Nobody has a shift you could swap for – try “Ask someone to cover”', 'error'); return; }
  const { form } = openModal({
    title: 'Swap this shift',
    submitLabel: 'Ask them',
    body: `<p><strong>${esc(when(s))}</strong> at ${esc(s.location_name)}</p>
      <label class="field"><span>Who with</span>
        <input type="search" class="swap-search" placeholder="Search names" aria-label="Search names" autocomplete="off">
        <select name="to_user_id" required size="6" class="swap-people">${people.map((p) => `<option value="${p.id}">${personLabel(p)}${p.busy ? ' · also on that day' : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Their shift you’ll do instead</span><select name="to_shift_id" required><option value="">Choose who first</option></select></label>
      ${field('Note (optional)', textarea('note', '', 'rows="2" maxlength="500" placeholder="e.g. I’ll do the open if you come in at 9"'))}
      <p class="muted small">Swapping with someone on the same day is fine – e.g. they start at 6am and you at 9am: you do the open, they come in at 9. They’ll be asked to agree, then a manager approves it. Until then your shifts stay as they are.</p>`,
    onSubmit: async (v) => {
      if (!v.to_user_id) throw new Error('Choose who to swap with');
      if (!v.to_shift_id) throw new Error('Choose which of their shifts you’ll do');
      await api('/swaps', { method: 'POST', body: { shift_id: s.id, to_user_id: Number(v.to_user_id), to_shift_id: Number(v.to_shift_id), note: v.note } });
      toast('Asked – they’ll need to agree, then a manager approves it');
      done();
    },
  });
  const list = form.querySelector('.swap-people');
  const theirs = form.querySelector('[name=to_shift_id]');
  list.addEventListener('change', () => {
    const p = people.find((x) => x.id === Number(list.value));
    // Their shift that day comes first and is picked for you – the usual same-day swap.
    const sorted = p ? [...p.shifts].sort((x, y) => (y.id === p.clash) - (x.id === p.clash)) : [];
    theirs.innerHTML = !p ? '<option value="">Choose who first</option>'
      : `<option value="">Choose their shift</option>${sorted.map((x) => `<option value="${x.id}" ${x.id === p.clash ? 'selected' : ''}>${esc(when(x))} – ${esc(x.location_name)}${x.date === s.date ? ' (same day)' : ''}</option>`).join('')}`;
  });
  searchable(form);
}

/** Ask a colleague to cover one of your shifts – they take it, you don't take one of theirs. */
export async function askToCover(s, done) {
  let opts;
  try { opts = await api(`/swaps/options?shift_id=${s.id}`); } catch (err) { showError(err); return; }
  if (!opts.people.length) { toast('There’s nobody who could cover that day', 'error'); return; }
  const free = opts.people.filter((p) => !p.busy);
  const busy = opts.people.filter((p) => p.busy);
  const { form } = openModal({
    title: 'Ask someone to cover',
    submitLabel: 'Ask them',
    body: `<p><strong>${esc(when(s))}</strong> at ${esc(s.location_name)}</p>
      <label class="field"><span>Who could cover it</span>
        <input type="search" class="swap-search" placeholder="Search names" aria-label="Search names" autocomplete="off">
        <select name="to_user_id" required size="7" class="swap-people">${free.map((p) => `<option value="${p.id}">${personLabel(p)}</option>`).join('')}
          ${busy.length ? `<optgroup label="Working then – swap instead">${busy.map((p) => `<option value="${p.id}" disabled>${personLabel(p)}</option>`).join('')}</optgroup>` : ''}</select></label>
      ${field('Note (optional)', textarea('note', '', 'rows="2" maxlength="500" placeholder="e.g. I’ve got a dentist appointment"'))}
      <p class="muted small">They’ll be asked to agree, then a manager approves it. Until then it’s still your shift.</p>`,
    onSubmit: async (v) => {
      if (!v.to_user_id) throw new Error('Choose who to ask');
      await api('/swaps', { method: 'POST', body: { shift_id: s.id, to_user_id: Number(v.to_user_id), to_shift_id: null, note: v.note } });
      toast('Asked – they’ll need to agree, then a manager approves it');
      done();
    },
  });
  searchable(form);
}

/**
 * The swaps card: swaps asked of you, your own swap requests, and (manager) swaps to approve. Empty when none.
 * opts.manage: show the ones to approve; opts.own: show your own and the ones asked of you.
 */
export function swapsPanel(data, { manage = false, own = true } = {}) {
  const forMe = own ? data.for_me.filter((w) => w.status === 'asked' || (w.status !== 'cancelled' && w.status !== 'refused')) : [];
  const mine = own ? data.mine : [];
  const approve = manage ? data.to_approve : [];
  if (!forMe.length && !mine.length && !approve.length) return '';
  return `<section class="card swaps-card">
    ${approve.length ? `<h2>Shift swaps to approve <span class="badge badge-sent">${approve.length}</span></h2>
      <ul class="drops-list">${approve.map((w) => `<li>
        <div>${what(w, 'manager')}<small>${where(w)}${w.note ? ` · “${esc(w.note)}”` : ''} · both have agreed</small>
          ${w.problem ? `<small class="tone-bad">⚠ ${esc(w.problem)}</small>` : ''}</div>
        <div class="drops-actions"><button class="btn btn-small btn-primary" data-swap-approve="${w.id}" ${w.problem ? 'disabled' : ''}>Approve</button>
          <button class="btn btn-small" data-swap-decline="${w.id}">Decline</button></div></li>`).join('')}</ul>` : ''}
    ${forMe.length ? `<h2>Swaps asked of you</h2>
      <ul class="drops-list">${forMe.map((w) => `<li>
        <div>${what(w, 'to')}<small>${where(w)} · from ${esc(w.from_name)}${w.note ? ` · “${esc(w.note)}”` : ''}</small>
          <small>${badge(w, 'to')}${w.decision_note ? ` “${esc(w.decision_note)}”` : ''}</small></div>
        <div class="drops-actions">${w.status === 'asked' ? `<button class="btn btn-small btn-primary" data-swap-accept="${w.id}">Agree</button>
          <button class="btn btn-small" data-swap-refuse="${w.id}">Say no</button>` : w.status === 'pending' ? `<button class="btn btn-small btn-ghost" data-swap-cancel="${w.id}">Call off</button>` : ''}</div></li>`).join('')}</ul>` : ''}
    ${mine.length ? `<h2>Your swap requests</h2>
      <ul class="drops-list">${mine.map((w) => `<li>
        <div>${what(w, 'from')}<small>${where(w)}</small><small>${badge(w)}${w.decision_note ? ` “${esc(w.decision_note)}”` : ''}</small></div>
        <div class="drops-actions">${['asked', 'pending'].includes(w.status) ? `<button class="btn btn-small btn-ghost" data-swap-cancel="${w.id}">Call off</button>` : ''}</div></li>`).join('')}</ul>` : ''}
  </section>`;
}

/** Wires the buttons in swapsPanel inside el. */
export function wireSwaps(el, data, done) {
  const find = (id) => [...data.mine, ...data.for_me, ...data.to_approve].find((w) => w.id === Number(id));
  const act = (sel, key, fn) => el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(find(b.dataset[key])); done(); } catch (err) { showError(err); b.disabled = false; }
  }));
  act('[data-swap-accept]', 'swapAccept', async (w) => { await api(`/swaps/${w.id}/accept`, { method: 'POST' }); toast('Agreed – a manager will approve it'); });
  act('[data-swap-refuse]', 'swapRefuse', async (w) => { await api(`/swaps/${w.id}/refuse`, { method: 'POST' }); toast(`Told ${w.from_name} you can’t`); });
  act('[data-swap-cancel]', 'swapCancel', async (w) => { await api(`/swaps/${w.id}/cancel`, { method: 'POST' }); toast('Swap called off – shifts stay as they are'); });
  act('[data-swap-approve]', 'swapApprove', async (w) => { await api(`/swaps/${w.id}/approve`, { method: 'POST' }); toast('Swap approved – the rota has been updated'); });
  el.querySelectorAll('[data-swap-decline]').forEach((b) => b.addEventListener('click', () => {
    const w = find(b.dataset.swapDecline);
    openModal({
      title: 'Decline this swap?',
      body: `<p>${what(w, 'manager')}</p><p class="muted small">Both keep their shifts as they are.</p>${field('Note for them (optional)', textarea('note', '', 'maxlength="500"'))}`,
      submitLabel: 'Decline',
      onSubmit: async (v) => { await api(`/swaps/${w.id}/decline`, { method: 'POST', body: { note: v.note } }); toast('Swap declined'); done(); },
    });
  }));
}
