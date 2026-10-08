import { api, esc, fmtDateTime } from '../lib.js';

// Notifications: everything Atlas has notified this person about (the last 60 days). Tapping a phone notification
// opens this page with that one at the top; each has a button to the page it's about.

const ICONS = {
  rota_published: '📅', shift_changed: '🔁', open_shift: '🙋', drop_decision: '✅', holiday_decision: '🏖️', news: '📣',
  holiday_request: '🏖️', drop_request: '🔁', late: '⏰', enquiry: '✉️', application: '🧑‍💼',
};
const GO = [[/^#\/rota\/requests/, 'Open requests'], [/^#\/rota\?view=mine/, 'See my shifts'], [/^#\/rota/, 'Open the rota'], [/^#\/timeoff/, 'Open time off'],
  [/^#\/mybrew/, 'Open My Atlas'], [/^#\/dashboard/, 'Open the dashboard'], [/^#\/events/, 'Open the enquiry'], [/^#\/people/, 'Open recruitment']];

const hashOf = (url) => { const i = (url ?? '').indexOf('#'); return i >= 0 ? url.slice(i) : ''; };

export async function render(ctx) {
  const { el, query, stale } = ctx;
  const data = await api('/notifications');
  if (stale()) return;
  const picked = Number(query.n) || null;
  const items = picked ? [...data.items.filter((n) => n.id === picked), ...data.items.filter((n) => n.id !== picked)] : data.items;
  const item = (n) => {
    const to = hashOf(n.url);
    const go = !to || to === '#/notifications' ? '' : n.kind === 'open_shift' ? 'Pick it up' : (GO.find(([re]) => re.test(to))?.[1] ?? 'Open');
    return `<li class="inbox-item ${n.read_at ? '' : 'is-new'} ${n.id === picked ? 'is-picked' : ''}">
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
    ${items.length ? `<ul class="inbox card">${items.map(item).join('')}</ul>`
      : '<div class="card empty">No notifications yet. When your rota is published, a shift changes or a request is answered, it shows up here.</div>'}
    <p class="muted small">Notifications are kept for 60 days. Choose which ones come to your phone in <a href="#/mybrew">My Atlas → Phone notifications</a>.</p>`;
  if (data.unread) api('/notifications/read', { method: 'POST' }).then(() => document.dispatchEvent(new Event('notifications-read'))).catch(() => {});
}
