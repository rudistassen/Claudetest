import { api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, select, showError, siteFilter, siteScope, textarea, toast, todayISO } from '../lib.js';
import { toBase64 } from './mybrew.js';

// Compliance beyond the food safety checks: Risk Management (risk assessments), Incident Management (accidents, near
// misses, complaints…), Documents (certificates, inspections, insurance – and when they run out) and Reporting.

const sitesOf = (state) => state.locations.filter((l) => l.active);
const everySite = (state) => state.isAdmin || !!state.user?.all_sites;
// A site drop-down for a form; "Every site" for people who work with every site.
const siteSelect = (state, selected, { allowAll = true } = {}) => select('location_id', [
  ...(allowAll && everySite(state) ? [['', 'Every site']] : []),
  ...sitesOf(state).map((l) => [l.id, l.name]),
], selected ?? (allowAll && everySite(state) && selected === null ? '' : state.locationId));
const scopeQuery = (state, scope) => qs({ location_id: scope === 'all' ? undefined : state.locationId });
function wireScope(el, navigate, page, extra = {}) {
  const form = el.querySelector('#cmp-filters');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(`${page}${qs({ scope: form.scope?.value, ...Object.fromEntries(Object.keys(extra).map((k) => [k, form[k]?.value || undefined])) })}`);
  });
  for (const k of Object.keys(extra)) form?.[k]?.addEventListener('change', () => form.requestSubmit());
}

// --- Risk Management ---

const RATING = { high: ['High', 'pill-bad'], medium: ['Medium', 'pill-warn'], low: ['Low', 'pill-good'] };
const LIKELIHOOD = [[1, '1 – Very unlikely'], [2, '2 – Unlikely'], [3, '3 – Possible'], [4, '4 – Likely'], [5, '5 – Very likely']];
const SEVERITY = [[1, '1 – Minor (no injury)'], [2, '2 – First aid'], [3, '3 – Injury or illness needing treatment'], [4, '4 – Serious injury'], [5, '5 – Major injury or death']];
const ratingPill = (r) => `<span class="pill ${RATING[r.rating][1]}" title="Likelihood ${r.likelihood} × severity ${r.severity} = ${r.score}">${RATING[r.rating][0]} · ${r.score}</span>`;

export async function renderRisks(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const data = await api(`/risks${scopeQuery(state, scope)}`);
  if (stale()) return;
  const due = data.risks.filter((r) => r.review_due);
  const count = (k) => data.risks.filter((r) => r.rating === k).length;
  const cats = [...new Set(data.risks.map((r) => r.category))];
  el.innerHTML = `
    <div class="page-head"><h1>Risk Management</h1>
      <div class="actions">${data.can_manage ? '<button class="btn btn-primary" id="risk-new">+ Risk assessment</button>' : ''}</div></div>
    ${state.multiSite ? `<form class="filters" id="cmp-filters">${siteFilter(state, scope)}</form>` : ''}
    ${data.risks.length ? `<div class="cmp-stats">
      <div class="cmp-stat"><strong>${data.risks.length}</strong><small>Risk assessments</small></div>
      <div class="cmp-stat tone-bad-soft"><strong>${count('high')}</strong><small>High risk</small></div>
      <div class="cmp-stat tone-warn-soft"><strong>${count('medium')}</strong><small>Medium</small></div>
      <div class="cmp-stat"><strong>${count('low')}</strong><small>Low</small></div>
      <div class="cmp-stat ${due.length ? 'tone-bad-soft' : ''}"><strong>${due.length}</strong><small>Due a review</small></div>
    </div>
    ${cats.map((c) => `<section class="card"><h2>${esc(c)}</h2><ul class="cmp-list">${data.risks.filter((r) => r.category === c).map((r) => `<li>
      <button type="button" class="cmp-row" data-risk="${r.id}">
        <span class="cmp-row-main"><strong>${esc(r.title)}</strong>
          <small class="muted">${esc(r.location_name ?? 'Every site')}${r.owner_name ? ` · ${esc(r.owner_name)}` : ''} · ${r.review_due ? `<span class="tone-bad">Review due ${fmtDate(r.review_on)}</span>` : `Review by ${fmtDate(r.review_on)}`}</small></span>
        ${ratingPill(r)}
      </button></li>`).join('')}</ul></section>`).join('')}`
    : `<div class="card empty">No risk assessments yet.${data.can_manage ? ' Add your first with <strong>+ Risk assessment</strong> – for example fire, slips and trips, hot surfaces, knives, cleaning chemicals, allergens and lone working.' : ''}</div>`}
    <p class="muted small">Each risk is scored likelihood × severity (1–5 each): 15 and over is high, 8–14 medium, under 8 low. Review them at least once a year, and after any incident.</p>`;
  wireScope(el, navigate, 'compliance/risks');

  const form = (r) => openModal({
    title: r ? 'Edit risk assessment' : 'New risk assessment',
    wide: true,
    submitLabel: r ? 'Save' : 'Add risk assessment',
    body: `<div class="row">${field('What it covers', input('title', r?.title, 'required maxlength="150" placeholder="e.g. Hot drinks and the espresso machine"'))}
        ${field('Type', select('category', data.categories.map((c) => [c, c]), r?.category ?? 'Health & safety'))}</div>
      <div class="row">${field('Site', siteSelect(state, r ? r.location_id : undefined))}
        ${field('Owner (optional)', select('owner_id', [['', '— Nobody in particular —'], ...data.people.map((p) => [p.id, p.name])], r?.owner_id ?? ''))}</div>
      ${field('The hazards – what could cause harm', textarea('hazards', r?.hazards, 'required rows="3" maxlength="4000"'))}
      ${field('Who might be harmed, and how (optional)', textarea('who_at_risk', r?.who_at_risk, 'rows="2" maxlength="1000" placeholder="e.g. Staff – scalds from steam wands; customers – hot drinks spilt"'))}
      ${field('What you already do to control it', textarea('controls', r?.controls, 'required rows="4" maxlength="4000"'))}
      ${field('Anything more to do (optional)', textarea('further_action', r?.further_action, 'rows="2" maxlength="4000"'))}
      <div class="row">${field('Likelihood (with these controls)', select('likelihood', LIKELIHOOD, r?.likelihood ?? 2))}${field('Severity', select('severity', SEVERITY, r?.severity ?? 2))}</div>
      ${field('Review by', input('review_on', r?.review_on, `type="date" min="${todayISO()}"`), { hint: 'Leave blank for a year from today' })}`,
    danger: r ? 'Remove' : null,
    onDanger: async () => {
      await api(`/risks/${r.id}`, { method: 'DELETE' });
      toast('Risk assessment removed');
      rerender();
    },
    onSubmit: async (v) => {
      await api(r ? `/risks/${r.id}` : '/risks', { method: r ? 'PUT' : 'POST', body: { ...v, location_id: v.location_id ?? '' } });
      toast(r ? 'Saved' : 'Risk assessment added');
      rerender();
    },
  });
  const view = (r) => {
    const { form: f, close } = openModal({
      title: r.title,
      wide: true,
      body: `<p>${ratingPill(r)} <span class="muted small">${esc(r.category)} · ${esc(r.location_name ?? 'Every site')}${r.owner_name ? ` · Owner: ${esc(r.owner_name)}` : ''}</span></p>
        <h3 class="group-title">Hazards</h3><p class="cmp-text">${esc(r.hazards)}</p>
        ${r.who_at_risk ? `<h3 class="group-title">Who might be harmed</h3><p class="cmp-text">${esc(r.who_at_risk)}</p>` : ''}
        <h3 class="group-title">Controls in place</h3><p class="cmp-text">${esc(r.controls)}</p>
        ${r.further_action ? `<h3 class="group-title">More to do</h3><p class="cmp-text">${esc(r.further_action)}</p>` : ''}
        <p class="muted small">Likelihood ${r.likelihood} × severity ${r.severity} = ${r.score}. ${r.review_due ? `<strong class="tone-bad">Review due ${fmtDate(r.review_on)}.</strong>` : `Review by ${fmtDate(r.review_on)}.`}
          ${r.reviewed_at ? `Last reviewed ${fmtDateTime(r.reviewed_at)}.` : ''}</p>
        ${data.can_manage ? `<div class="actions"><button type="button" class="btn" data-edit>Edit</button><button type="button" class="btn" data-reviewed>Reviewed – still right</button></div>` : ''}`,
    });
    f.querySelector('[data-edit]')?.addEventListener('click', () => { close(); form(r); });
    f.querySelector('[data-reviewed]')?.addEventListener('click', async () => {
      try {
        const next = await api(`/risks/${r.id}/reviewed`, { method: 'POST', body: {} });
        close();
        toast(`Reviewed – next review ${fmtDate(next.review_on)}`);
        rerender();
      } catch (err) { showError(err); }
    });
  };
  el.querySelector('#risk-new')?.addEventListener('click', () => form(null));
  el.querySelectorAll('[data-risk]').forEach((b) => b.addEventListener('click', () => view(data.risks.find((r) => r.id === Number(b.dataset.risk)))));
}

// --- Incident Management ---

const STATUS = { open: ['Open', 'pill-bad'], investigating: ['Investigating', 'pill-warn'], closed: ['Closed', 'pill-good'] };
const statusPill = (s) => `<span class="pill ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

function incidentForm(state, kinds, i, done) {
  return openModal({
    title: i ? 'Edit incident' : 'Report an incident',
    wide: true,
    submitLabel: i ? 'Save' : 'Report it',
    body: `<div class="row">${field('Site', siteSelect(state, i?.location_id, { allowAll: false }))}${field('What kind of incident', select('kind', Object.entries(kinds), i?.kind ?? 'accident'))}</div>
      <div class="row">${field('When', input('occurred_on', i?.occurred_on ?? todayISO(), `type="date" required max="${todayISO()}"`))}${field('Time (optional)', input('occurred_at', i?.occurred_at, 'type="time"'))}</div>
      ${field('What happened, in a few words', input('title', i?.title, 'required maxlength="150" placeholder="e.g. Customer slipped by the door"'))}
      ${field('What happened', textarea('description', i?.description, 'required rows="4" maxlength="6000" placeholder="Where, what led up to it and what happened"'))}
      ${field('Who was involved (optional)', textarea('people_involved', i?.people_involved, 'rows="2" maxlength="2000" placeholder="Names, and contact details for customers or witnesses"'))}
      ${field('Any injury (optional)', textarea('injury', i?.injury, 'rows="2" maxlength="2000" placeholder="What the injury was, and any first aid given"'))}
      ${field('What was done straight away (optional)', textarea('action_taken', i?.action_taken, 'rows="2" maxlength="4000"'))}
      <label class="check"><input type="checkbox" name="riddor" ${i?.riddor ? 'checked' : ''}> It may need reporting to the HSE (RIDDOR) – e.g. a serious injury, someone taken to hospital, or off work for over 7 days</label>`,
    onSubmit: async (v) => done(await api(i ? `/incidents/${i.id}` : '/incidents', { method: i ? 'PUT' : 'POST', body: v })),
  });
}

export async function renderIncidents(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const scope = siteScope(state, query.scope);
  const status = ['closed', 'all'].includes(query.status) ? query.status : 'active';
  const data = await api(`/incidents${qs({ status, location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  el.innerHTML = `
    <div class="page-head"><h1>Incident Management</h1>
      <div class="actions"><button class="btn btn-primary" id="inc-new">+ Report an incident</button></div></div>
    <form class="filters" id="cmp-filters">${state.multiSite ? siteFilter(state, scope) : ''}
      <select name="status" aria-label="Which incidents">
        <option value="active" ${status === 'active' ? 'selected' : ''}>Open and being investigated</option>
        <option value="closed" ${status === 'closed' ? 'selected' : ''}>Closed</option>
        <option value="all" ${status === 'all' ? 'selected' : ''}>All</option>
      </select></form>
    ${data.can_manage ? '' : '<p class="muted small">You see the incidents you’ve reported. Your manager sees every incident at your site.</p>'}
    ${data.incidents.length ? `<section class="card"><ul class="cmp-list">${data.incidents.map((i) => `<li>
      <a class="cmp-row" href="#/compliance/incidents/${i.id}">
        <span class="cmp-date"><strong>${fmtDate(i.occurred_on, { day: 'numeric', month: 'short' })}</strong><small class="muted">${esc(i.occurred_at ?? '')}</small></span>
        <span class="cmp-row-main"><strong>${esc(i.title)}</strong>
          <small class="muted">${esc(data.kinds[i.kind] ?? i.kind)} · ${esc(i.location_name ?? '')} · reported by ${esc(i.reported_by_name ?? 'someone who has left')}${i.riddor ? ' · <span class="tone-bad">RIDDOR?</span>' : ''}</small></span>
        ${statusPill(i.status)}
      </a></li>`).join('')}</ul></section>`
    : `<div class="card empty">${status === 'active' ? 'No open incidents. ' : 'Nothing here. '}If something happens – an accident, a near miss, a complaint or a pest sighting – use <strong>+ Report an incident</strong>.</div>`}`;
  wireScope(el, navigate, 'compliance/incidents', { status: 1 });
  el.querySelector('#inc-new').addEventListener('click', () => incidentForm(state, data.kinds, null, (saved) => {
    toast('Incident reported');
    navigate(`compliance/incidents/${saved.id}`);
  }));
}

export async function renderIncident(ctx) {
  const { el, state, params, stale, rerender } = ctx;
  const data = await api(`/incidents/${Number(params[0])}`);
  if (stale()) return;
  const i = data.incident;
  const part = (title, text) => (text ? `<h3 class="group-title">${title}</h3><p class="cmp-text">${esc(text)}</p>` : '');
  el.innerHTML = `
    <div class="page-head"><h1>${esc(i.title)}</h1>
      <div class="actions"><a class="btn" href="#/compliance/incidents">‹ Incidents</a>
        ${data.can_manage ? '<button class="btn" id="inc-edit">Edit</button>' : ''}</div></div>
    <section class="card">
      <p>${statusPill(i.status)} <strong>${esc(data.kinds[i.kind] ?? i.kind)}</strong> · ${esc(i.location_name ?? '')} · ${fmtDate(i.occurred_on, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}${i.occurred_at ? `, ${esc(i.occurred_at)}` : ''}</p>
      <p class="muted small">Reported by ${esc(i.reported_by_name ?? 'someone who has left')} on ${fmtDateTime(i.created_at)}${i.riddor ? ' · <strong class="tone-bad">May need reporting to the HSE (RIDDOR)</strong>' : ''}</p>
      ${part('What happened', i.description)}${part('Who was involved', i.people_involved)}${part('Injury', i.injury)}${part('What was done straight away', i.action_taken)}
      ${i.status === 'closed' ? part(`Outcome – closed by ${esc(i.closed_by_name ?? 'someone')} ${i.closed_at ? `on ${fmtDateTime(i.closed_at)}` : ''}`, i.outcome) : ''}
      ${data.can_manage ? `<div class="actions">
        ${i.status === 'open' ? '<button class="btn" data-status="investigating">Mark as investigating</button>' : ''}
        ${i.status !== 'closed' ? '<button class="btn btn-primary" data-close>Close incident</button>' : '<button class="btn" data-status="open">Reopen</button>'}
      </div>` : ''}
    </section>
    <section class="card">
      <h2>Follow-up</h2>
      ${data.notes.length ? `<ul class="cmp-notes">${data.notes.map((n) => `<li><p class="cmp-text">${esc(n.body)}</p><small class="muted">${esc(n.author ?? 'Someone')} · ${fmtDateTime(n.created_at)}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing yet – add notes as you follow it up (calls made, what you found, what’s changed).</p>'}
      <form id="inc-note" class="cmp-note-form">${textarea('body', '', 'rows="2" maxlength="4000" placeholder="Add a note…" required')}<button class="btn">Add note</button></form>
    </section>`;
  el.querySelector('#inc-edit')?.addEventListener('click', () => incidentForm(state, data.kinds, i, () => { toast('Saved'); rerender(); }));
  el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/incidents/${i.id}/status`, { method: 'POST', body: { status: b.dataset.status } }); rerender(); } catch (err) { showError(err); }
  }));
  el.querySelector('[data-close]')?.addEventListener('click', () => openModal({
    title: 'Close incident',
    body: field('What was the outcome?', textarea('outcome', '', 'required rows="3" maxlength="4000" placeholder="What you found, what’s been put right, and anything changed so it doesn’t happen again"')),
    submitLabel: 'Close incident',
    onSubmit: async (v) => {
      await api(`/incidents/${i.id}/status`, { method: 'POST', body: { status: 'closed', outcome: v.outcome } });
      toast('Incident closed');
      rerender();
    },
  }));
  el.querySelector('#inc-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try { await api(`/incidents/${i.id}/notes`, { method: 'POST', body: { body } }); rerender(); } catch (err) { showError(err); }
  });
}

// --- Documents ---

const EXPIRY = { expired: ['Expired', 'pill-bad'], soon: ['Runs out soon', 'pill-warn'], ok: ['In date', 'pill-good'], none: ['No expiry', ''] };
const docUrl = (d, download = false) => `/api/compliance-docs/${d.id}/file${download ? '?download=1' : ''}`;

export async function renderDocuments(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const scope = siteScope(state, query.scope);
  const data = await api(`/compliance-docs${scopeQuery(state, scope)}`);
  if (stale()) return;
  const n = (k) => data.documents.filter((d) => d.expiry === k).length;
  el.innerHTML = `
    <div class="page-head"><h1>Documents</h1><div class="actions"><button class="btn btn-primary" id="doc-new">+ Upload document</button></div></div>
    ${state.multiSite ? `<form class="filters" id="cmp-filters">${siteFilter(state, scope)}</form>` : ''}
    ${n('expired') || n('soon') ? `<p class="notice">${n('expired') ? `<strong>${n('expired')} expired</strong>` : ''}${n('expired') && n('soon') ? ' and ' : ''}${n('soon') ? `<strong>${n('soon')} running out in the next 30 days</strong>` : ''} – upload the new ones when you have them.</p>` : ''}
    ${data.documents.length ? `<section class="card"><div class="table-wrap"><table class="cmp-docs">
      <thead><tr><th>Document</th><th>Site</th><th>Expires</th><th></th></tr></thead>
      <tbody>${data.documents.map((d) => `<tr>
        <td><a href="${docUrl(d)}" target="_blank" rel="noopener"><strong>${esc(d.title)}</strong></a><small class="muted">${esc(data.categories[d.category] ?? d.category)}${d.notes ? ` · ${esc(d.notes)}` : ''}</small></td>
        <td>${esc(d.location_name ?? 'Every site')}</td>
        <td>${d.expires_on ? fmtDate(d.expires_on, { day: 'numeric', month: 'short', year: 'numeric' }) : '–'} ${EXPIRY[d.expiry][1] ? `<span class="pill ${EXPIRY[d.expiry][1]}">${EXPIRY[d.expiry][0]}</span>` : ''}</td>
        <td class="cmp-doc-actions"><a class="btn btn-small btn-ghost" href="${docUrl(d, true)}">Download</a><button class="btn btn-small" data-doc="${d.id}">Edit</button></td>
      </tr>`).join('')}</tbody></table></div></section>`
    : '<div class="card empty">No compliance documents yet. Upload your certificates (gas safety, electrical, PAT testing, fire alarm and extinguisher servicing), your food hygiene inspection report, insurance and licences – Atlas flags each one before it runs out.</div>'}`;
  wireScope(el, navigate, 'compliance/documents');

  const form = (d) => {
    const { form: f } = openModal({
      title: d ? 'Edit document' : 'Upload a document',
      wide: true,
      submitLabel: d ? 'Save' : 'Upload',
      body: `<div class="row">${field('Title', input('title', d?.title, 'required maxlength="150" placeholder="e.g. Gas safety certificate"'))}
          ${field('Type', select('category', Object.entries(data.categories), d?.category ?? 'certificate'))}</div>
        <div class="row">${field('Site', siteSelect(state, d ? d.location_id : undefined))}
          ${field('Issued (optional)', input('issued_on', d?.issued_on, 'type="date"'))}
          ${field('Expires (optional)', input('expires_on', d?.expires_on, 'type="date"'))}</div>
        ${field('Notes (optional)', input('notes', d?.notes, 'maxlength="2000" placeholder="e.g. Engineer, policy number, rating"'))}
        ${field(d ? 'Replace the file (optional)' : 'File', '<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,.txt">', { hint: `PDF, photo, Word or Excel, up to 20 MB${d ? ` · now: ${d.file_name}` : ''}` })}`,
      danger: d ? 'Delete' : null,
      onDanger: async () => {
        if (!(await confirmDialog(`Delete “${d.title}”?`, { confirmLabel: 'Delete' }))) return;
        await api(`/compliance-docs/${d.id}`, { method: 'DELETE' });
        toast('Deleted');
        rerender();
      },
      onSubmit: async (v, formEl) => {
        const file = formEl.file.files[0];
        if (!d && !file) throw new Error('Choose the file to upload');
        if (file && file.size > 20 * 1024 * 1024) throw new Error('Documents can be up to 20 MB');
        const body = { title: v.title, category: v.category, location_id: v.location_id ?? '', issued_on: v.issued_on, expires_on: v.expires_on, notes: v.notes,
          ...(file ? { file_name: file.name, media_type: file.type, data: await toBase64(file) } : {}) };
        await api(d ? `/compliance-docs/${d.id}` : '/compliance-docs', { method: d ? 'PUT' : 'POST', body });
        toast(d ? 'Saved' : 'Uploaded');
        rerender();
      },
    });
    return f;
  };
  el.querySelector('#doc-new').addEventListener('click', () => form(null));
  el.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => form(data.documents.find((d) => d.id === Number(b.dataset.doc)))));
}

// --- Reporting: the compliance reports, as tiles ---

export function renderReporting({ el, state }) {
  const tiles = [
    ['compliance/reporting/food-safety', '▤', 'Compliance report', 'How each site is doing with its food safety checks, and every failed check', true],
    ['compliance/incidents?status=all', '✚', 'Incident log', 'Every incident, open and closed', state.can('incidents.manage')],
    ['compliance/risks', '⚠', 'Risk register', 'Every risk assessment, its rating and when it’s due a review', state.can('risk.view', 'risk.manage')],
  ].filter((t) => t[4]);
  el.innerHTML = `<div class="page-head"><h1>Reporting</h1></div>
    <div class="hub-tiles" data-tone="trail">${tiles.map(([href, ic, label, note]) => `<a class="hub-tile" href="#/${href}">
      <span class="hub-icon" aria-hidden="true">${ic}</span><span class="hub-text"><strong>${esc(label)}</strong><small>${esc(note)}</small></span>
      <span class="hub-go" aria-hidden="true">›</span></a>`).join('')}</div>`;
}
