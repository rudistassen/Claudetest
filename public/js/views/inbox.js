import { api, esc, fmtDateTime } from '../lib.js';

// Notifications: everything Atlas has notified this person about (the last 60 days). Tapping a phone notification
// opens this page with that one at the top; each has a button to the page it's about.

const ICONS = {
  rota_published: '📅', shift_changed: '🔁', open_shift: '🙋', drop_decision: '✅', holiday_decision: '🏖️', news: '📣',
  holiday_request: '🏖️', drop_request: '🔁', late: '⏰', enquiry: '✉️', application: '🧑‍💼',
  incident: '🩹', task: '✔️', training: '🎓', training_signoff: '🎓', order_reply: '📦', pickup_request: '🙋',
};
const GO = [[/^#\/rota\/requests/, 'Open requests'], [/^#\/rota\?view=mine/, 'See my shifts'], [/^#\/rota/, 'Open the rota'], [/^#\/timeoff/, 'Open time off'],
  [/^#\/mybrew/, 'Open My Atlas'], [/^#\/dashboard/, 'Open the dashboard'], [/^#\/events/, 'Open the enquiry'], [/^#\/people/, 'Open recruitment'],
  [/^#\/compliance\/incidents/, 'Open the incident'], [/^#\/tasks/, 'Open tasks'], [/^#\/learn/, 'Open the course'], [/^#\/orders/, 'Open the order']];

const hashOf = (url) => { const i = (url ?? '').indexOf('#'); return i >= 0 ? url.slice(i) : ''; };

export async function render(ctx) {
  const { el, query, stale } = ctx;
  const data = await api('/notifications');
  if (stale()) return;
  const picked = Number(query.n) || null;
  const items = picked ? [...data.items.filter((n) => n.id === picked), ...data.items.filter((n) => n.id !== picked)] : data.items;
  const groupOf = (n) => data.groups?.[n.kind] ?? 'Other';
  // Filters: everything, the new ones, or one kind (Your shifts, Holiday, For managers…) – plus a search.
  const groups = [...new Set(items.map(groupOf))];
  const count = (g) => items.filter((n) => groupOf(n) === g).length;
  const newCount = items.filter((n) => !n.read_at).length;
  const chip = (key, label, n) => `<button type="button" class="chip chip-btn ${key === 'all' ? 'is-on' : ''}" data-filter="${esc(key)}" aria-pressed="${key === 'all'}">${esc(label)} <span class="muted">${n}</span></button>`;
  const item = (n) => {
    const to = hashOf(n.url);
    const go = !to || to === '#/notifications' ? '' : n.kind === 'open_shift' ? 'Pick it up' : (GO.find(([re]) => re.test(to))?.[1] ?? 'Open');
    return `<li class="inbox-item ${n.read_at ? '' : 'is-new'} ${n.id === picked ? 'is-picked' : ''}" data-group="${esc(groupOf(n))}" data-text="${esc(`${n.title} ${n.body ?? ''}`.toLowerCase())}">
      <span class="inbox-icon" aria-hidden="true">${ICONS[n.kind] ?? '🔔'}</span>
      <div class="inbox-text">
        <strong>${esc(n.title)}</strong>
        ${n.body ? `<span>${esc(n.body)}</span>` : ''}
        <small class="muted">${fmtDateTime(n.created_at)}${n.read_at ? '' : ' · <span class="inbox-new">New</span>'}</small>
      </div>
      ${go ? `<a class="btn btn-small" href="${esc(to)}">${esc(go)}</a>` : ''}
    </li>`;
  };
  el.innerHTML = `<div class="page-head"><h1>Notifications</h1>
      <div class="actions"><a class="btn" href="#/mybrew">My Atlas</a></div></div>
    ${items.length > 3 ? `<div class="inbox-filters">
      <div class="chips">${chip('all', 'All', items.length)}${newCount ? chip('new', 'New', newCount) : ''}${groups.length > 1 ? groups.map((g) => chip(g, g, count(g))).join('') : ''}</div>
      <input type="search" id="inbox-search" placeholder="Search notifications" aria-label="Search notifications">
    </div>` : ''}
    ${items.length ? `<ul class="inbox card">${items.map(item).join('')}</ul><p class="inbox-none card empty" hidden>Nothing matches.</p>`
      : '<div class="card empty">No notifications yet. When your rota is published, a shift changes or a request is answered, it shows up here.</div>'}
    <p class="muted small">Notifications are kept for 60 days. Choose which ones come to your phone in <a href="#/mybrew">My Atlas → Phone notifications</a>.</p>`;
  let filter = 'all';
  const apply = () => {
    const q = (el.querySelector('#inbox-search')?.value ?? '').trim().toLowerCase();
    let shown = 0;
    el.querySelectorAll('.inbox-item').forEach((li) => {
      const ok = (filter === 'all' || (filter === 'new' ? li.classList.contains('is-new') : li.dataset.group === filter)) && (!q || li.dataset.text.includes(q));
      li.hidden = !ok;
      if (ok) shown++;
    });
    const none = el.querySelector('.inbox-none');
    if (none) none.hidden = shown > 0;
  };
  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    el.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    apply();
  }));
  el.querySelector('#inbox-search')?.addEventListener('input', apply);
  if (data.unread) api('/notifications/read', { method: 'POST' }).then(() => document.dispatchEvent(new Event('notifications-read'))).catch(() => {});
}
