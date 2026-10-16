import { api, esc, fmtDateTime, showError, toast } from '../lib.js';

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
  // Every type they can get (and any others in the list), for the type filter.
  const groups = [...new Set([...(data.my_groups ?? []), ...items.map(groupOf)])];
  const count = (g) => items.filter((n) => groupOf(n) === g).length;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const londonDay = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const ageDays = (n) => Math.round((Date.parse(today) - Date.parse(londonDay(n.created_at))) / 86400000);
  const item = (n) => {
    const to = hashOf(n.url);
    const go = !to || to === '#/notifications' ? '' : n.kind === 'open_shift' ? 'Pick it up' : (GO.find(([re]) => re.test(to))?.[1] ?? 'Open');
    return `<li class="inbox-item ${n.read_at ? '' : 'is-new'} ${n.id === picked ? 'is-picked' : ''}" data-id="${n.id}" data-group="${esc(groupOf(n))}" data-age="${ageDays(n)}" data-text="${esc(`${n.title} ${n.body ?? ''}`.toLowerCase())}">
      <span class="inbox-icon" aria-hidden="true">${ICONS[n.kind] ?? '🔔'}</span>
      <div class="inbox-text">
        <strong>${esc(n.title)}</strong>
        ${n.body ? `<span>${esc(n.body)}</span>` : ''}
        <small class="muted">${fmtDateTime(n.created_at)}<span class="inbox-new-tag">${n.read_at ? '' : ' · <span class="inbox-new">New</span>'}</span></small>
      </div>
      <div class="inbox-actions">
        ${go ? `<a class="btn btn-small" href="${esc(to)}" data-open="${n.id}">${esc(go)}</a>` : ''}
        ${n.read_at ? '' : `<button type="button" class="btn btn-small btn-ghost" data-read="${n.id}" title="Mark as read">✓ Read</button>`}
      </div>
    </li>`;
  };
  const unread = () => el.querySelectorAll('.inbox-item.is-new').length;
  el.innerHTML = `<div class="page-head"><h1>Notifications</h1>
      <div class="actions"><button class="btn" id="inbox-read-all" ${data.unread ? '' : 'hidden'}>✓ Mark all as read</button><a class="btn" href="#/mybrew">My Atlas</a></div></div>
    ${items.length ? `<form class="inbox-filters filters" id="inbox-filters">
      <select name="type" aria-label="Type"><option value="">All types</option>${groups.map((g) => `<option value="${esc(g)}">${esc(g)}${count(g) ? ` (${count(g)})` : ''}</option>`).join('')}</select>
      <select name="read" aria-label="Read or unread"><option value="">Read and unread</option><option value="unread">Unread only</option><option value="read">Read only</option></select>
      <select name="when" aria-label="When"><option value="">Any time</option><option value="0">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
      <input type="search" name="q" placeholder="Search notifications" aria-label="Search notifications">
      <span class="muted small" id="inbox-count"></span>
    </form>` : ''}
    ${items.length ? `<ul class="inbox card">${items.map(item).join('')}</ul><p class="inbox-none card empty" hidden>Nothing matches these filters.</p>`
      : '<div class="card empty">No notifications yet. When your rota is published, a shift changes or a request is answered, it shows up here.</div>'}
    <p class="muted small">Notifications are kept for 60 days. Choose which ones come to your phone in <a href="#/mybrew">My Atlas → Phone notifications</a>.</p>`;

  const form = el.querySelector('#inbox-filters');
  const apply = () => {
    if (!form) return;
    const { type, read, when } = { type: form.type.value, read: form.read.value, when: form.when.value };
    const q = form.q.value.trim().toLowerCase();
    let shown = 0;
    el.querySelectorAll('.inbox-item').forEach((li) => {
      const isNew = li.classList.contains('is-new');
      const ok = (!type || li.dataset.group === type) && (!read || (read === 'unread' ? isNew : !isNew))
        && (when === '' || Number(li.dataset.age) <= Number(when)) && (!q || li.dataset.text.includes(q));
      li.hidden = !ok;
      if (ok) shown++;
    });
    el.querySelector('.inbox-none').hidden = shown > 0;
    el.querySelector('#inbox-count').textContent = type || read || when !== '' || q ? `${shown} of ${items.length}` : '';
  };
  form?.addEventListener('input', apply);
  form?.addEventListener('submit', (e) => e.preventDefault());

  // Reading them: one at a time (opening it, or ✓ Read), or all at once.
  const markRead = (li) => {
    li.classList.remove('is-new');
    li.querySelector('.inbox-new-tag').innerHTML = '';
    li.querySelector('[data-read]')?.remove();
    el.querySelector('#inbox-read-all').hidden = !unread();
  };
  const readOne = (id) => {
    const li = el.querySelector(`.inbox-item[data-id="${id}"]`);
    if (!li?.classList.contains('is-new')) return;
    markRead(li);
    api(`/notifications/${id}/read`, { method: 'POST' }).then(() => document.dispatchEvent(new Event('notifications-read'))).catch(() => {});
  };
  el.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', () => { readOne(b.dataset.read); apply(); }));
  el.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', () => readOne(a.dataset.open)));
  el.querySelector('#inbox-read-all').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/notifications/read', { method: 'POST' });
      el.querySelectorAll('.inbox-item.is-new').forEach(markRead);
      document.dispatchEvent(new Event('notifications-read'));
      toast('All marked as read');
      apply();
    } catch (err) { showError(err); }
    e.target.disabled = false;
  });
  // Opened from a phone notification: that one has been seen.
  if (picked) readOne(picked);
}
