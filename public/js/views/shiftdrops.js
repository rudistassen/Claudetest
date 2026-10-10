import { api, esc, field, fmtDate, openModal, showError, siteColour, textarea, toast, todayISO } from '../lib.js';

// Dropping shifts and open shifts, shared by My Atlas and the rota: staff ask to drop a shift, a manager approves
// it (it becomes an open shift at that site) or declines it, and anyone, from any site, can ask to pick an open
// shift up – a manager at that site approves it before it goes on their rota.

const when = (d) => `${d.date === todayISO() ? 'Today' : fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.start_time}–${d.end_time}`;
const hrs = (h) => `${Number(h).toLocaleString('en-GB', { maximumFractionDigits: 2 })} h`;
const site = (d) => `<span class="site-dot" style="--site: ${siteColour(d.location_name, d.location_id)}"></span>${esc(d.location_name)}`;

/** Ask to drop one of your shifts (s: a shift from /my-shifts). */
export function askToDrop(s, done) {
  openModal({
    title: 'Drop this shift?',
    body: `<p><strong>${esc(when(s))}</strong> at ${esc(s.location_name)}</p>
      <p class="muted small">A manager needs to approve it first. Until then it’s still your shift. Once approved, it comes off your rota and anyone (from any site) can pick it up.</p>
      ${field('Reason (optional)', textarea('reason', '', 'maxlength="500" placeholder="e.g. Exam that day"'))}`,
    submitLabel: 'Ask to drop',
    onSubmit: async (v) => {
      await api(`/shifts/${s.id}/drop`, { method: 'POST', body: { reason: v.reason } });
      toast('Asked to drop – a manager will approve it');
      done();
    },
  });
}

/**
 * The open shifts / drop requests card: requests waiting for this person to approve, open shifts they can pick
 * up, and their own requests. opts.open: false leaves open shifts out (the rota shows them in its grid).
 */
export function dropsPanel(data, { open = true } = {}) {
  const openList = open ? data.open : [];
  const mine = data.mine.filter((d) => d.status === 'pending' || d.status === 'declined');
  const myClaims = data.my_claims ?? [];
  if (!data.to_approve.length && !openList.length && !mine.length && !myClaims.length) return '';
  const drops = data.to_approve.filter((d) => d.kind !== 'claim');
  const claims = data.to_approve.filter((d) => d.kind === 'claim');
  return `<section class="card drops-card">
    ${claims.length ? `<h2>Shift pick-up requests <span class="badge badge-sent">${claims.length}</span></h2>
      <ul class="drops-list">${claims.map((d) => `<li>
        <div><strong>${esc(d.claimed_by_name)}</strong> wants to pick up <strong>${esc(when(d))}</strong>
          <small>${site(d)} · ${hrs(d.hours)}${d.position ? ` · ${esc(d.position)}` : ''}</small>
          ${d.claim_problem ? `<small class="tone-bad">⚠ ${esc(d.claim_problem.replace(/^You’re/, 'They’re').replace(/^You /, 'They '))}</small>` : ''}</div>
        <div class="drops-actions"><button class="btn btn-small btn-primary" data-claim-approve="${d.id}" ${d.claim_problem ? 'disabled' : ''}>Approve</button>
          <button class="btn btn-small" data-claim-decline="${d.id}">Decline</button></div></li>`).join('')}</ul>` : ''}
    ${drops.length ? `<h2>Shift drop requests <span class="badge badge-sent">${drops.length}</span></h2>
      <ul class="drops-list">${drops.map((d) => `<li>
        <div><strong>${esc(d.dropped_by_name)}</strong> wants to drop <strong>${esc(when(d))}</strong>
          <small>${site(d)} · ${hrs(d.hours)}${d.reason ? ` · “${esc(d.reason)}”` : ''}</small></div>
        <div class="drops-actions"><button class="btn btn-small btn-primary" data-drop-approve="${d.id}">Approve</button>
          <button class="btn btn-small" data-drop-delete="${d.id}" title="Approve, but delete the shift instead of offering it to others">Delete shift</button>
          <button class="btn btn-small" data-drop-decline="${d.id}">Decline</button></div></li>`).join('')}</ul>` : ''}
    ${myClaims.length ? `<h2>Shifts you’ve asked to pick up</h2>
      <ul class="drops-list">${myClaims.map((d) => `<li>
        <div><strong>${esc(when(d))}</strong><small>${site(d)} · ${hrs(d.hours)} · waiting for a manager to approve</small></div>
        <div class="drops-actions"><button class="btn btn-small btn-ghost" data-claim-cancel="${d.id}">Cancel</button></div></li>`).join('')}</ul>` : ''}
    ${openList.length ? `<h2>Open shifts <span class="badge badge-new">${openList.length}</span></h2>
      <ul class="drops-list">${openList.map((d) => `<li>
        <div><strong>${esc(when(d))}</strong><small>${site(d)} · ${hrs(d.hours)}${d.position ? ` · ${esc(d.position)}` : ''}</small>
          ${d.can_claim ? '' : `<small class="muted">${esc(d.claim_problem ?? '')}</small>`}</div>
        <div class="drops-actions">${d.can_claim ? `<button class="btn btn-small btn-primary" data-claim="${d.id}">Pick up</button>` : ''}
          ${d.can_withdraw ? `<button class="btn btn-small btn-ghost" data-withdraw="${d.id}">Withdraw</button>` : ''}</div></li>`).join('')}</ul>` : ''}
    ${mine.length ? `<h2>Your drop requests</h2>
      <ul class="drops-list">${mine.map((d) => `<li>
        <div><strong>${esc(when(d))}</strong><small>${site(d)} · ${d.status === 'pending' ? 'waiting for a manager' : `<span class="tone-bad">declined</span>${d.decided_by_name ? ` by ${esc(d.decided_by_name)}` : ''}${d.decision_note ? ` – “${esc(d.decision_note)}”` : ''} · it’s still your shift`}</small></div>
        <div class="drops-actions">${d.status === 'pending' ? `<button class="btn btn-small btn-ghost" data-drop-cancel="${d.id}">Cancel</button>` : ''}</div></li>`).join('')}</ul>` : ''}
  </section>`;
}

/** A pick-up request on the rota (an open shift someone has asked for): managers approve or decline it there. */
export function claimRequest(d, done, { canDecide = false } = {}) {
  openModal({
    title: 'Pick-up request',
    body: `<p><strong>${esc(d.claimed_by_name)}</strong> has asked to pick up this open shift.</p>
      <p><strong>${esc(when(d))}</strong> · ${site(d)} · ${hrs(d.hours)}</p>
      ${canDecide ? '<p class="muted small">Approve it and it goes onto their rota. Decline and it’s open for anyone again.</p>' : '<p class="muted small">Waiting for a manager at this site to approve it.</p>'}`,
    submitLabel: 'Approve',
    onSubmit: canDecide ? async () => {
      await api(`/shift-drops/${d.id}/approve-claim`, { method: 'POST' });
      toast(`Approved – ${when(d)} is on ${d.claimed_by_name}’s rota`);
      done();
    } : null,
    danger: canDecide ? 'Decline' : null,
    onDanger: async () => {
      await api(`/shift-drops/${d.id}/decline-claim`, { method: 'POST' });
      toast('Declined – it’s an open shift again');
      done();
    },
  });
}

/** Pick up an open shift (d: an open shift from /shift-drops, or the rota's open_shifts). */
export function claimShift(d, done, { canClaim = true, problem = null, canWithdraw = false } = {}) {
  openModal({
    title: 'Open shift',
    body: `<p><strong>${esc(when(d))}</strong></p>
      <p>${site(d)} · ${hrs(d.hours)}${d.break_minutes ? ` · ${d.break_minutes} min break` : ''}${d.position ? ` · ${esc(d.position)}` : ''}</p>
      ${d.notes ? `<p class="small">${esc(d.notes)}</p>` : ''}
      ${canClaim ? '<p class="muted small">A manager needs to approve it first – it’s held for you until they do, and you’ll get a notification.</p>' : problem ? `<p class="notice">${esc(problem)}</p>` : ''}`,
    submitLabel: 'Ask to pick up',
    onSubmit: canClaim ? async () => {
      const r = await api(`/shift-drops/${d.id}/claim`, { method: 'POST' });
      toast(r.status === 'claimed' ? 'It’s yours – added to your rota' : 'Asked to pick up – a manager will approve it');
      done();
    } : null,
    danger: canWithdraw ? 'Withdraw' : null,
    onDanger: async () => { await api(`/shift-drops/${d.id}/withdraw`, { method: 'POST' }); toast('Open shift withdrawn'); done(); },
  });
}

/** Wires the buttons in dropsPanel (and any data-claim buttons) inside el. */
export function wireDrops(el, data, done) {
  const find = (id) => [...data.open, ...data.to_approve, ...data.mine, ...(data.my_claims ?? [])].find((d) => d.id === Number(id));
  const act = (sel, fn) => el.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try { await fn(b); } catch (err) { showError(err); b.disabled = false; }
  }));
  act('[data-drop-approve]', async (b) => {
    const d = find(b.dataset.dropApprove);
    await api(`/shift-drops/${d.id}/approve`, { method: 'POST' });
    toast(`Approved – ${when(d)} is now an open shift at ${d.location_name}`);
    done();
  });
  el.querySelectorAll('[data-drop-delete]').forEach((b) => b.addEventListener('click', () => {
    const d = find(b.dataset.dropDelete);
    openModal({
      title: 'Approve and delete the shift?',
      body: `<p><strong>${esc(d.dropped_by_name)}</strong> · ${esc(when(d))} at ${esc(d.location_name)}</p>
        <p class="muted small">It comes off ${esc(d.dropped_by_name)}’s rota and is deleted – it isn’t offered to anyone else. Use this when the shift isn’t needed any more.</p>`,
      submitLabel: 'Delete shift',
      onSubmit: async () => {
        await api(`/shift-drops/${d.id}/approve`, { method: 'POST', body: { delete: true } });
        toast('Approved – the shift has been deleted');
        done();
      },
    });
  }));
  el.querySelectorAll('[data-drop-decline]').forEach((b) => b.addEventListener('click', () => {
    const d = find(b.dataset.dropDecline);
    openModal({
      title: `Decline ${d.dropped_by_name}’s request?`,
      body: `<p>${esc(when(d))} at ${esc(d.location_name)} stays on their rota.</p>${field('Note for them (optional)', textarea('note', '', 'maxlength="500"'))}`,
      submitLabel: 'Decline',
      onSubmit: async (v) => {
        await api(`/shift-drops/${d.id}/decline`, { method: 'POST', body: { note: v.note } });
        toast('Declined');
        done();
      },
    });
  }));
  act('[data-claim-approve]', async (b) => {
    const d = find(b.dataset.claimApprove);
    await api(`/shift-drops/${d.id}/approve-claim`, { method: 'POST' });
    toast(`Approved – ${when(d)} is on ${d.claimed_by_name}’s rota`);
    done();
  });
  el.querySelectorAll('[data-claim-decline]').forEach((b) => b.addEventListener('click', () => {
    const d = find(b.dataset.claimDecline);
    openModal({
      title: `Decline ${d.claimed_by_name}’s request?`,
      body: `<p>${esc(when(d))} at ${esc(d.location_name)} will be open for anyone to pick up again.</p>${field('Note for them (optional)', textarea('note', '', 'maxlength="500"'))}`,
      submitLabel: 'Decline',
      onSubmit: async (v) => {
        await api(`/shift-drops/${d.id}/decline-claim`, { method: 'POST', body: { note: v.note } });
        toast('Declined – it’s an open shift again');
        done();
      },
    });
  }));
  act('[data-claim-cancel]', async (b) => {
    await api(`/shift-drops/${b.dataset.claimCancel}/cancel-claim`, { method: 'POST' });
    toast('Request cancelled');
    done();
  });
  act('[data-drop-cancel]', async (b) => {
    await api(`/shift-drops/${b.dataset.dropCancel}/cancel`, { method: 'POST' });
    toast('Request cancelled – the shift is still yours');
    done();
  });
  el.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = find(b.dataset.claim);
    claimShift(d, done, { canClaim: d.can_claim, problem: d.claim_problem, canWithdraw: d.can_withdraw });
  }));
  act('[data-withdraw]', async (b) => {
    await api(`/shift-drops/${b.dataset.withdraw}/withdraw`, { method: 'POST' });
    toast('Open shift withdrawn');
    done();
  });
}
