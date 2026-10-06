import { api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, select, showError, siteColour, siteFilter, siteScope, textarea, toast, todayISO } from '../lib.js';

// Events: enquiries from the events inbox and the conversation about each (emails in and out, and notes), and the
// events calendar.

export const STATUSES = [['new', 'New'], ['replied', 'Replied'], ['provisional', 'Provisional'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['lost', 'Lost']];
const STATUS = Object.fromEntries(STATUSES);
const statusBadge = (s) => `<span class="ev-status ev-${s}">${STATUS[s] ?? esc(s)}</span>`;
const EVENT_TYPES = ['Birthday party', 'Wedding / reception', 'Corporate', 'Meeting', 'Private hire', 'Christening / baptism', 'Wake', 'Baby shower', 'Christmas party', 'Other'];
const changed = () => window.dispatchEvent(new Event('events:changed'));
const FIELD_NAMES = { title: 'title', event_type: 'type of event', event_date: 'date', start_time: 'start', end_time: 'end', guests: 'guests', budget: 'budget', phone: 'phone', location_id: 'site' };
const when = (e) => [e.event_date ? fmtDate(e.event_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : null,
  e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ''}` : null].filter(Boolean).join(' · ');

// The details of an enquiry or event: used to add one, and on its page.
function detailsFields(state, e = {}) {
  const sites = state.locations.filter((l) => l.active);
  return `
    ${field('Title', input('title', e.title, 'maxlength="200" placeholder="e.g. Sarah’s 40th birthday"'))}
    <div class="row">${field('Site', select('location_id', [['', '— Not decided —'], ...sites.map((l) => [l.id, l.name])], e.location_id ?? ''))}
      ${field('Type of event', `<input name="event_type" list="ev-types" maxlength="100" value="${esc(e.event_type ?? '')}"><datalist id="ev-types">${EVENT_TYPES.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`)}</div>
    <div class="row">${field('Date', input('event_date', e.event_date, 'type="date"'))}${field('Start', input('start_time', e.start_time, 'type="time"'))}${field('End', input('end_time', e.end_time, 'type="time"'))}</div>
    <div class="row">${field('Guests', input('guests', e.guests, 'type="number" min="0" step="1"'))}${field('Budget (£)', input('budget', e.budget, 'type="number" min="0" step="0.01"'))}
      ${field('Status', select('status', STATUSES, e.status ?? 'new'))}</div>
    <h3 class="ev-sub">Contact</h3>
    <div class="row">${field('Name', input('name', e.name, 'required maxlength="100"'))}${field('Phone', input('phone', e.phone, 'type="tel" maxlength="50"'))}</div>
    ${field('Email', input('email', e.email, 'type="email" maxlength="200"'))}
    ${field('Notes', textarea('notes', e.notes, 'rows="4" maxlength="5000" placeholder="Menu, drinks, set-up, deposit…"'))}`;
}

export function newEnquiryDialog(state, navigate, preset = {}) {
  openModal({
    title: preset.status === 'confirmed' ? 'Add an event' : 'New enquiry',
    wide: true,
    body: detailsFields(state, { location_id: state.multiSite ? null : state.locationId, ...preset }),
    submitLabel: 'Add',
    onSubmit: async (v) => {
      const r = await api('/events/enquiries', { method: 'POST', body: v });
      toast('Added');
      navigate(`events/enquiries/${r.id}`);
    },
  });
}

// ---- Enquiries ----

// How long someone has been waiting for a reply, from when their email arrived (SQLite UTC time).
const hoursSince = (sqlUtc) => (Date.now() - new Date(`${String(sqlUtc).replace(' ', 'T')}Z`).getTime()) / 3600000;
function waitedFor(sqlUtc) {
  const h = hoursSince(sqlUtc);
  if (h < 1) return 'under an hour';
  if (h < 24) return `${Math.floor(h)} hour${Math.floor(h) === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

const SHOW = [['open', 'Open'], ['confirmed', 'Confirmed'], ['closed', 'Completed & lost'], ['all', 'All']];

function inboxCard(inbox) {
  if (!inbox) return '';
  if (!inbox.configured) {
    const have = new Set(inbox.setup?.filter((v) => v.status === 'ok').map((v) => v.name));
    return `<details class="card inbox-card"><summary><strong>✉ Events inbox</strong> <span class="muted small">– have enquiries added here, and reply from Brewly</span></summary>
      <p>Emails to your events address (for example <em>events@yourcompany.co.uk</em>) are added here every few minutes, and your replies are sent from that address – in the same email thread.</p>
      <p>It uses the same Microsoft 365 app as the invoice and careers inboxes. In Railway, add:</p>
      <ul><li><code>EVENTS_MAILBOX</code> – the events inbox’s email address${have.has('EVENTS_MAILBOX') ? ' ✓' : ''}</li>
        ${['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'].map((n) => `<li><code>${n}</code>${have.has(n) ? ' ✓ already there' : ' – from the Microsoft app'}</li>`).join('')}</ul>
      <p class="muted small">To send replies from Brewly, the Microsoft app also needs the <strong>Mail.Send</strong> permission (with admin consent). Until then you can write replies here and send them from your own email.</p>
    </details>`;
  }
  return `<section class="card inbox-card">
    <div class="card-head"><h2>✉ Events inbox</h2><button class="btn btn-small" id="ev-check">Check now</button></div>
    <p class="small">Emails to <strong>${esc(inbox.mailbox)}</strong> are added every few minutes, and replies are sent from it.
      ${inbox.last_check ? `Last checked ${fmtDateTime(inbox.last_check.replace('T', ' ').slice(0, 19))}.` : 'Not checked yet.'}</p>
    ${inbox.last_error ? `<p class="notice notice-warn">${esc(inbox.last_error)}</p>` : ''}
  </section>`;
}

export async function renderEnquiries(ctx) {
  const { el, state, query, stale, navigate, rerender } = ctx;
  const show = SHOW.some(([k]) => k === query.show) ? query.show : 'open';
  const scope = siteScope(state, query.scope);
  const siteId = scope === 'all' ? undefined : state.locationId;
  const [rows, inbox, sum] = await Promise.all([
    api(`/events/enquiries${qs({ show, location_id: siteId })}`),
    api('/events/inbox').catch(() => null),
    api(`/events/summary${qs({ location_id: siteId })}`),
  ]);
  if (stale()) return;
  const c = sum.counts;

  el.innerHTML = `
    <div class="page-head"><h1>Enquiries</h1><div class="actions"><button class="btn btn-primary" id="ev-new">+ New enquiry</button></div></div>
    <div class="kpis ev-kpis">
      <button type="button" class="kpi kpi-button ${c.needs_reply ? 'kpi-bad' : 'kpi-good'}" data-icon="✉" id="ev-to-reply"><span>Need a reply</span><strong>${c.needs_reply}</strong>
        <small>${c.needs_reply ? `oldest waiting ${esc(waitedFor(sum.needs_reply[0].waiting_since))}` : 'All caught up'}</small></button>
      <div class="kpi" data-icon="✦"><span>New this week</span><strong>${c.new_this_week}</strong></div>
      <div class="kpi ${c.provisional ? 'kpi-warn' : ''}" data-icon="◔"><span>Provisional</span><strong>${c.provisional}</strong><small>to firm up</small></div>
      <a class="kpi" data-icon="✓" href="#/events/calendar"><span>Confirmed events ahead</span><strong>${c.confirmed_ahead}</strong></a>
    </div>
    <div class="ev-summary">
      <section class="card" id="ev-reply">
        <h2>Needs a reply <span class="badge ${c.needs_reply ? 'badge-sent' : ''}">${c.needs_reply}</span></h2>
        ${sum.needs_reply.length ? `<ul class="ev-mini">${sum.needs_reply.map((e) => `<li><a href="#/events/enquiries/${e.id}">
          <span><strong>${esc(e.name)}</strong>${e.title ? ` <span class="muted">${esc(e.title)}</span>` : ''}
            <small class="muted">${esc((e.last_text ?? '').replace(/\s+/g, ' ').slice(0, 110))}</small></span>
          <span class="ev-wait ${hoursSince(e.waiting_since) >= 24 ? 'is-late' : ''}">${esc(waitedFor(e.waiting_since))}</span></a></li>`).join('')}</ul>`
          : '<p class="muted small">✓ Nobody is waiting for a reply.</p>'}
      </section>
      <section class="card">
        <h2>Next two weeks</h2>
        ${sum.upcoming.length ? `<ul class="ev-mini">${sum.upcoming.map((e) => `<li><a href="#/events/enquiries/${e.id}">
          <span><strong>${esc(e.title || e.name)}</strong><small class="muted">${esc(when(e))}${e.guests ? ` · ${e.guests} guests` : ''}${e.location_name ? ` · ${esc(e.location_name)}` : ''}</small></span>
          ${statusBadge(e.status)}</a></li>`).join('')}</ul>`
          : '<p class="muted small">No events in the next two weeks.</p>'}
      </section>
    </div>
    <form class="filters" id="ev-filters">
      <div class="seg" role="group" aria-label="Show">${SHOW.map(([k, l]) => `<button type="button" data-show="${k}" class="${k === show ? 'is-on' : ''}">${l}</button>`).join('')}</div>
      ${siteFilter(state, scope)}
    </form>
    ${rows.length ? `<ul class="ev-list">${rows.map((e) => `<li class="ev-row ${e.unread ? 'is-unread' : ''}">
      <a href="#/events/enquiries/${e.id}">
        <span class="ev-dot" ${e.unread ? 'title="Something new to read"' : 'hidden'}></span>
        <span class="ev-main">
          <span class="ev-top"><strong>${esc(e.name)}</strong>${e.title ? ` <span class="ev-title">${esc(e.title)}</span>` : ''}</span>
          <span class="ev-meta">${[when(e) ? `📅 ${esc(when(e))}` : '<span class="muted">No date yet</span>', e.guests ? `👥 ${e.guests}` : null, e.event_type ? esc(e.event_type) : null,
            e.location_name ? `<span class="site-dot" style="--site: ${siteColour(e.location_name, e.location_id)}"></span>${esc(e.location_name)}` : null].filter(Boolean).join(' · ')}</span>
          ${e.last_text ? `<span class="ev-preview">${e.last_direction === 'out' ? '<strong>You:</strong> ' : ''}${esc(e.last_text.replace(/\s+/g, ' '))}</span>` : ''}
        </span>
        <span class="ev-side">${statusBadge(e.status)}<small class="muted">${e.last_message_at ? fmtDateTime(e.last_message_at) : ''}</small></span>
      </a></li>`).join('')}</ul>`
      : `<div class="empty">${show === 'open' ? 'No open enquiries – new ones from the events inbox appear here.' : 'Nothing here.'}</div>`}
    ${inboxCard(inbox)}`;

  const form = el.querySelector('#ev-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); navigate(`events/enquiries${qs({ show: show === 'open' ? undefined : show, scope: form.scope?.value })}`); });
  form.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => navigate(`events/enquiries${qs({ show: b.dataset.show === 'open' ? undefined : b.dataset.show, scope: query.scope })}`)));
  el.querySelector('#ev-new').addEventListener('click', () => newEnquiryDialog(state, navigate));
  el.querySelector('#ev-to-reply').addEventListener('click', () => el.querySelector('#ev-reply').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  el.querySelector('#ev-check')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/events/inbox/check', { method: 'POST' });
      toast(r.error ? r.error : r.added ? `${r.added} new email${r.added === 1 ? '' : 's'} added` : 'No new emails', r.error ? 'error' : 'ok');
      changed();
      rerender();
    } catch (err) { showError(err); e.target.disabled = false; }
  });
}

// ---- One enquiry: the conversation and the details ----

export async function renderEnquiry(ctx) {
  const { el, state, params, stale, navigate, rerender } = ctx;
  const e = await api(`/events/enquiries/${params[0]}`);
  if (stale()) return;
  changed();
  const fileUrl = (f) => `/api/events/enquiries/${e.id}/files/${f.id}`;
  const filesFor = (mid) => e.files.filter((f) => f.message_id === mid);
  const hasThread = e.messages.some((m) => m.direction === 'in');

  const bubble = (m) => {
    const files = filesFor(m.id);
    const who = m.direction === 'in' ? esc(m.from_name || m.from_address || e.name)
      : m.direction === 'note' ? `Note${m.sent_by_name ? ` by ${esc(m.sent_by_name)}` : ''}`
        : `${esc(m.sent_by_name ?? 'You')}${m.status === 'logged' ? ' · sent from their own email' : ''}`;
    return `<li class="ev-msg ev-msg-${m.direction}">
      <div class="ev-msg-head"><strong>${who}</strong><span class="muted">${fmtDateTime(m.created_at)}</span></div>
      ${m.subject && m.direction !== 'note' ? `<div class="ev-msg-subject">${esc(m.subject)}</div>` : ''}
      <div class="ev-msg-body">${esc(m.body ?? '')}</div>
      ${files.length ? `<div class="ev-files">${files.map((f) => `<button type="button" class="chip chip-btn" data-file="${f.id}">📎 ${esc(f.file_name)}</button>`).join('')}</div>` : ''}
    </li>`;
  };

  el.innerHTML = `
    <p class="small"><a href="#/events/enquiries">← Enquiries</a></p>
    <div class="page-head"><div><h1>${esc(e.title || e.name)}</h1>
      <p class="muted small">${e.title ? `${esc(e.name)} · ` : ''}${when(e) || 'No date yet'}${e.guests ? ` · ${e.guests} guests` : ''}${e.location_name ? ` · ${esc(e.location_name)}` : ''}</p></div>
      <div class="actions"><label class="ev-status-pick">${statusBadge(e.status)}<select id="ev-status" aria-label="Status">${STATUSES.map(([k, l]) => `<option value="${k}" ${k === e.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>
    <div class="ev-layout">
      <section class="card ev-thread-card">
        <h2>Conversation</h2>
        ${e.messages.length ? `<ul class="ev-thread">${e.messages.map(bubble).join('')}</ul>` : '<p class="muted small">Nothing yet – write to them below.</p>'}
        <form class="ev-compose" id="ev-compose">
          ${!hasThread ? field('Subject', input('subject', `Re: ${e.title || 'your event enquiry'}`, 'maxlength="300"')) : ''}
          <textarea name="body" rows="6" maxlength="20000" placeholder="${e.email ? `Write to ${esc(e.name.split(' ')[0])}… or add a note for the team` : 'Add a note for the team (add their email address to write to them)'}"></textarea>
          <div class="ev-compose-actions">
            <button type="button" class="btn" data-send="note">Add note</button>
            ${e.email ? (e.can_send
              ? `<button type="submit" class="btn btn-primary" data-send="email">✉ Send email</button>`
              : `<button type="button" class="btn btn-primary" data-send="mailto">✉ Open in my email</button>`) : ''}
          </div>
          ${e.email ? `<p class="muted small">${e.can_send ? `Sent from ${esc(e.mailbox)} to ${esc(e.email)}${hasThread ? ', as a reply in their email thread' : ''}.`
            : 'The events inbox can’t send yet – this opens your email with the message ready, and keeps a copy here.'}</p>` : ''}
        </form>
      </section>
      <form class="card ev-details" id="ev-details">
        <div class="card-head"><h2>Details</h2>${e.can_read && hasThread ? '<button type="button" class="btn btn-small" id="ev-fill" title="Read their emails and fill in anything still blank">✨ Fill in from emails</button>' : ''}</div>
        ${e.filled_fields.length ? `<p class="notice small ev-filled-note">✨ Filled in from their email: <strong>${e.filled_fields.map((k) => FIELD_NAMES[k] ?? k).join(', ')}</strong> – check them, then Save.</p>` : ''}
        ${detailsFields(state, e)}
        <div class="ev-details-actions"><button class="btn btn-ghost" type="button" id="ev-delete">Delete</button><button class="btn btn-primary">Save</button></div>
      </form>
    </div>`;

  const thread = el.querySelector('.ev-thread');
  if (thread) thread.lastElementChild?.scrollIntoView({ block: 'nearest' });

  el.querySelector('#ev-status').addEventListener('change', async (ev) => {
    try { await api(`/events/enquiries/${e.id}`, { method: 'PUT', body: { status: ev.target.value } }); toast(`Marked as ${STATUS[ev.target.value].toLowerCase()}`); rerender(); } catch (err) { showError(err); }
  });

  const compose = el.querySelector('#ev-compose');
  const send = async (kind) => {
    const body = compose.elements.body.value.trim();
    if (!body) { showError(new Error('Write something first')); return; }
    const subject = compose.elements.subject?.value;
    if (kind === 'mailto') {
      window.location.href = `mailto:${encodeURIComponent(e.email)}?${new URLSearchParams({ subject: subject || `Re: ${e.title || 'your event enquiry'}`, body }).toString().replace(/\+/g, '%20')}`;
      kind = 'logged';
    }
    compose.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api(`/events/enquiries/${e.id}/messages`, { method: 'POST', body: { kind, body, subject } });
      toast(kind === 'note' ? 'Note added' : kind === 'logged' ? 'Kept a copy here' : `Sent to ${e.email}`);
      rerender();
    } catch (err) {
      showError(err);
      compose.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  compose.addEventListener('submit', (ev) => { ev.preventDefault(); send('email'); });
  compose.querySelectorAll('[data-send]').forEach((b) => { if (b.type !== 'submit') b.addEventListener('click', () => send(b.dataset.send)); });

  el.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', async () => {
    const f = e.files.find((x) => x.id === Number(b.dataset.file));
    try {
      const r = await fetch(fileUrl(f));
      if (!r.ok) throw new Error('The file couldn’t be opened');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), rel: 'noopener' });
      if (f.file_type === 'application/pdf' || f.file_type.startsWith('image/')) a.target = '_blank'; else a.download = f.file_name;
      a.click();
    } catch (err) { showError(err); }
  }));

  const details = el.querySelector('#ev-details');
  for (const k of e.filled_fields) details.querySelector(`[name="${k}"]`)?.classList.add('ev-filled');
  el.querySelector('#ev-fill')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Reading…';
    try {
      const r = await api(`/events/enquiries/${e.id}/fill`, { method: 'POST' });
      toast(r.filled.length ? `Filled in ${r.filled.map((k) => FIELD_NAMES[k] ?? k).join(', ')}` : 'Nothing new to fill in – the blanks aren’t in their emails');
      rerender();
    } catch (err) { showError(err); ev.target.disabled = false; ev.target.textContent = '✨ Fill in from emails'; }
  });
  details.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = Object.fromEntries([...details.elements].filter((x) => x.name).map((x) => [x.name, x.value === '' ? null : x.value]));
    try { await api(`/events/enquiries/${e.id}`, { method: 'PUT', body: v }); toast('Saved'); rerender(); } catch (err) { showError(err); }
  });
  el.querySelector('#ev-delete').addEventListener('click', async () => {
    if (!await confirmDialog(`Delete this enquiry and its ${e.messages.length} message${e.messages.length === 1 ? '' : 's'}? To keep a record, mark it as Lost instead.`, { confirmLabel: 'Delete' })) return;
    try { await api(`/events/enquiries/${e.id}`, { method: 'DELETE' }); toast('Deleted'); changed(); navigate('events/enquiries'); } catch (err) { showError(err); }
  });
}

// ---- Calendar ----

const monthStart = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const isoOf = (d) => `${ymOf(d)}-${String(d.getDate()).padStart(2, '0')}`;

export async function renderCalendar(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const ym = /^\d{4}-\d{2}$/.test(query.m ?? '') ? query.m : todayISO().slice(0, 7);
  const scope = siteScope(state, query.scope);
  const first = monthStart(ym);
  // Six weeks from the Monday on or before the 1st.
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const rows = await api(`/events/calendar${qs({ from: isoOf(days[0]), to: isoOf(days[41]), location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const byDay = new Map();
  for (const r of rows) byDay.set(r.event_date, [...(byDay.get(r.event_date) ?? []), r]);
  const today = todayISO();
  const shift = (n) => ymOf(new Date(first.getFullYear(), first.getMonth() + n, 1));
  const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const chip = (r) => `<a class="ev-chip ev-${r.status}" href="#/events/enquiries/${r.id}" title="${esc([r.title || r.name, r.location_name, STATUS[r.status]].filter(Boolean).join(' · '))}"
    ${r.location_name ? `style="--site: ${siteColour(r.location_name, r.location_id)}"` : ''}>${r.start_time ? `<b>${r.start_time}</b> ` : ''}${esc(r.title || r.name)}</a>`;
  const inMonth = rows.filter((r) => r.event_date.startsWith(ym));
  const link = (m) => `#/events/calendar${qs({ m, scope: query.scope })}`;

  el.innerHTML = `
    <div class="page-head"><h1>Events calendar</h1><div class="actions"><button class="btn btn-primary" id="ev-add">+ Add event</button></div></div>
    <form class="filters" id="cal-filters">
      <div class="cal-nav"><a class="btn btn-small" href="${link(shift(-1))}" aria-label="Previous month">‹</a>
        <strong class="cal-month">${esc(label)}</strong>
        <a class="btn btn-small" href="${link(shift(1))}" aria-label="Next month">›</a>
        ${ym !== today.slice(0, 7) ? `<a class="btn btn-small btn-ghost" href="${link(today.slice(0, 7))}">This month</a>` : ''}</div>
      ${siteFilter(state, scope)}
    </form>
    <p class="cal-legend small">${['provisional', 'confirmed', 'completed', 'new'].map((s) => `<span class="ev-chip ev-${s}">${s === 'new' ? 'Enquiry' : STATUS[s]}</span>`).join('')}</p>
    <div class="cal-grid" role="grid">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
      ${days.map((d) => {
        const iso = isoOf(d);
        const list = byDay.get(iso) ?? [];
        return `<div class="cal-day ${d.getMonth() !== first.getMonth() ? 'is-other' : ''} ${iso === today ? 'is-today' : ''}" data-day="${iso}">
          <span class="cal-num">${d.getDate()}</span>${list.map(chip).join('')}</div>`;
      }).join('')}
    </div>
    <section class="card cal-agenda">
      <h2>${esc(label)}</h2>
      ${inMonth.length ? `<ul class="ev-list">${inMonth.map((r) => `<li class="ev-row"><a href="#/events/enquiries/${r.id}">
        <span class="ev-main"><span class="ev-top"><strong>${esc(r.title || r.name)}</strong></span>
          <span class="ev-meta">📅 ${esc(when(r))}${r.guests ? ` · 👥 ${r.guests}` : ''}${r.location_name ? ` · ${esc(r.location_name)}` : ''}</span></span>
        <span class="ev-side">${statusBadge(r.status)}</span></a></li>`).join('')}</ul>` : '<p class="muted small">No events this month.</p>'}
    </section>`;

  const form = el.querySelector('#cal-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); navigate(`events/calendar${qs({ m: ym, scope: form.scope?.value })}`); });
  el.querySelector('#ev-add').addEventListener('click', () => newEnquiryDialog(state, navigate, { status: 'confirmed' }));
  // Double-click an empty part of a day to add an event on it.
  el.querySelectorAll('.cal-day').forEach((c) => c.addEventListener('dblclick', (e) => {
    if (e.target.closest('.ev-chip')) return;
    newEnquiryDialog(state, navigate, { status: 'confirmed', event_date: c.dataset.day });
  }));
}
