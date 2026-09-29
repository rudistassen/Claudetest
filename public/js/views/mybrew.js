import { api, esc, field, fmtDate, fmtDateTime, input, money, openModal, select, showError, textarea, toast, todayISO } from '../lib.js';

// My Brew: each person's own page – their details, upcoming shifts, holiday and the staff news feed.
// Setup → News is where announcements and policy updates are posted.

export const CATEGORIES = {
  announcement: ['Announcement', 'news-announcement'],
  policy: ['Policy update', 'news-policy'],
  event: ['Event', 'news-event'],
  reminder: ['Reminder', 'news-reminder'],
};

// Post text: paragraphs and line breaks kept, web addresses made into links.
function formatBody(text) {
  return String(text).split(/\n{2,}/).map((para) => `<p>${esc(para)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br>')}</p>`).join('');
}

const initials = (name) => String(name).replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export async function renderMyBrew(ctx) {
  const { el, state, stale } = ctx;
  const [shifts, leave, news] = await Promise.all([api('/my-shifts'), api('/leave/mine'), api('/news')]);
  if (stale()) return;
  const u = state.user;
  const today = todayISO();
  const siteName = (id) => state.locations.find((l) => l.id === id)?.name ?? '';
  const sites = u.role === 'admin' || u.all_sites ? 'All sites' : state.locations.map((l) => l.name).join(', ');
  const next = shifts.slice(0, 6);
  const weekHours = shifts.filter((s) => s.date < addDaysISO(today, 7)).reduce((t, s) => t + (s.hours ?? 0), 0);
  const upcomingLeave = leave.requests.filter((r) => r.status === 'approved' && r.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const pending = leave.requests.filter((r) => r.status === 'pending').length;
  const toRead = news.filter((p) => p.requires_ack && !p.read).length;
  let filter = 'all';

  const post = (p) => `
    <article class="news-post ${p.pinned ? 'is-pinned' : ''} ${p.requires_ack && !p.read ? 'needs-read' : ''}" data-post="${p.id}" data-category="${p.category}">
      <header>
        <span class="news-tag ${CATEGORIES[p.category][1]}">${CATEGORIES[p.category][0]}</span>
        ${p.pinned ? '<span class="news-pin" title="Pinned">📌 Pinned</span>' : ''}
        <span class="muted small">${fmtDate(p.created_at.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}${p.author ? ` · ${esc(p.author)}` : ''}${p.updated_at ? ' · updated' : ''}</span>
      </header>
      <h3>${esc(p.title)}</h3>
      <div class="news-body">${formatBody(p.body)}</div>
      <button class="link-btn news-more" hidden>Read more</button>
      ${p.requires_ack ? (p.read ? '<p class="news-read">✓ You’ve read this</p>' : `<button class="btn btn-primary btn-small" data-ack="${p.id}">I’ve read this</button>`) : ''}
    </article>`;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>My Brew</h1><p class="muted my-greeting">${greeting()}, ${esc(u.name.replace(/\s*\(.*\)$/, '').split(' ')[0])} · ${fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
    </div>
    ${toRead ? `<p class="notice">📌 <strong>${toRead} ${toRead === 1 ? 'update needs' : 'updates need'}</strong> you to confirm you’ve read ${toRead === 1 ? 'it' : 'them'} – see the news below.</p>` : ''}
    <div class="mybrew">
      <aside class="mybrew-side">
        <section class="card my-profile">
          <div class="my-avatar" aria-hidden="true">${esc(initials(u.name))}</div>
          <div>
            <h2>${esc(u.name)}</h2>
            <p class="muted">${esc([u.rota_group, u.access_name ?? u.role].filter(Boolean).join(' · '))}</p>
          </div>
          <dl class="my-details">
            ${u.location_id ? `<dt>Home site</dt><dd>${esc(siteName(u.location_id))}</dd>` : ''}
            <dt>Sites</dt><dd>${esc(sites)}</dd>
            <dt>Email</dt><dd>${esc(u.email)}</dd>
            ${u.hourly_rate ? `<dt>Pay rate</dt><dd>${money(u.hourly_rate)} an hour</dd>` : ''}
          </dl>
          <p class="my-links"><a href="#/account">Change password</a> · <a href="#/timeoff">Availability</a></p>
        </section>
        <section class="card my-shifts-card">
          <h2>Your next shifts</h2>
          ${next.length ? `<ul class="my-shift-list">${next.map((s) => `<li class="${s.date === today ? 'is-today' : ''}">
              <span class="my-shift-day">${s.date === today ? 'Today' : fmtDate(s.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              <span class="my-shift-time">${s.start_time}–${s.end_time}</span>
              <span class="muted small">${esc(s.location_name ?? '')}</span></li>`).join('')}</ul>
            <p class="small muted">${Math.round(weekHours * 10) / 10} hours in the next 7 days</p>`
            : '<p class="muted">No shifts on the rota for the next two weeks.</p>'}
          <a class="small" href="#/rota?view=mine">All my shifts →</a>
        </section>
        <section class="card">
          <h2>Holiday</h2>
          <p><strong>${leave.booked_this_year}</strong> day${leave.booked_this_year === 1 ? '' : 's'} booked in ${leave.year}</p>
          ${upcomingLeave ? `<p class="small">Next: ${fmtDate(upcomingLeave.start_date)}${upcomingLeave.end_date !== upcomingLeave.start_date ? ` – ${fmtDate(upcomingLeave.end_date)}` : ''}</p>` : ''}
          ${pending ? `<p class="small muted">${pending} request${pending === 1 ? '' : 's'} waiting for approval</p>` : ''}
          <a class="small" href="#/timeoff">Request holiday →</a>
        </section>
      </aside>
      <section class="mybrew-news">
        <div class="news-head">
          <h2>News</h2>
          <div class="seg" role="group" aria-label="Show">
            ${[['all', 'All'], ['announcement', 'Announcements'], ['policy', 'Policies'], ['event', 'Events'], ['reminder', 'Reminders']]
              .filter(([k]) => k === 'all' || news.some((p) => p.category === k))
              .map(([k, l]) => `<button data-filter="${k}" class="${k === 'all' ? 'is-on' : ''}">${l}</button>`).join('')}
          </div>
        </div>
        ${news.length ? news.map(post).join('') : '<div class="card empty">No news yet.</div>'}
      </section>
    </div>`;

  // Long posts are shortened with "Read more".
  el.querySelectorAll('.news-post').forEach((a) => {
    const bodyEl = a.querySelector('.news-body');
    if (bodyEl.scrollHeight > 190) {
      bodyEl.classList.add('is-clipped');
      const more = a.querySelector('.news-more');
      more.hidden = false;
      more.addEventListener('click', () => { bodyEl.classList.toggle('is-clipped'); more.textContent = bodyEl.classList.contains('is-clipped') ? 'Read more' : 'Show less'; });
    }
  });
  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    el.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('is-on', x === b));
    el.querySelectorAll('.news-post').forEach((a) => { a.hidden = filter !== 'all' && a.dataset.category !== filter; });
  }));
  el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/news/${b.dataset.ack}/read`, { method: 'POST' });
      const article = b.closest('.news-post');
      article.classList.remove('needs-read');
      b.outerHTML = '<p class="news-read">✓ You’ve read this</p>';
      toast('Thanks – marked as read');
      window.dispatchEvent(new Event('news:read'));
    } catch (err) { showError(err); }
  }));
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --- Setup → News ---

export async function renderNewsSetup(ctx) {
  const { el, state, stale, rerender } = ctx;
  const posts = await api('/news/manage');
  if (stale()) return;
  const sites = state.locations.filter((l) => l.active);
  const canAll = state.isAdmin || !!state.user.all_sites;
  const siteNames = (p) => (p.all_sites ? 'Every site' : p.site_ids.map((id) => sites.find((l) => l.id === id)?.name ?? '').filter(Boolean).join(', '));

  el.innerHTML = `
    <div class="page-head">
      <h1>News</h1>
      <div class="actions"><button class="btn btn-primary" id="add">+ New post</button></div>
    </div>
    <p class="muted">Announcements and policy updates for the news feed on everyone’s <a href="#/mybrew">My Brew</a> page. Policy updates can ask people to confirm they’ve read them, and you can see who has.</p>
    <section class="card">
      ${posts.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Post</th><th>Type</th><th>Who sees it</th><th>Posted</th><th>Read</th></tr></thead>
        <tbody>${posts.map((p) => `<tr class="${p.can_edit ? 'clickable' : ''}" data-edit="${p.id}">
          <td><strong>${esc(p.title)}</strong>${p.pinned ? ' <span class="small">📌</span>' : ''}</td>
          <td><span class="news-tag ${CATEGORIES[p.category][1]}">${CATEGORIES[p.category][0]}</span></td>
          <td class="small">${esc(siteNames(p))}</td>
          <td class="small muted">${fmtDateTime(p.created_at)}${p.author ? `<br>${esc(p.author)}` : ''}</td>
          <td>${p.requires_ack ? `<button class="btn btn-small" data-reads="${p.id}">${p.reads} of ${p.audience}</button>` : '<span class="muted small">–</span>'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No posts yet. Click <strong>+ New post</strong> to write the first one.</div>'}
    </section>`;

  const form = (p) => `
    ${field('Title', input('title', p.title, 'required maxlength="150"'))}
    <div class="row">
      ${field('Type', select('category', Object.entries(CATEGORIES).map(([k, [l]]) => [k, l]), p.category ?? 'announcement'))}
      <div class="field"><span>Who sees it</span>
        ${select('audience', [...(canAll ? [['all', 'Every site']] : []), ['sites', 'Only the sites ticked below']], p.id ? (p.all_sites ? 'all' : 'sites') : canAll ? 'all' : 'sites')}
      </div>
    </div>
    <div class="site-picks news-sites" ${p.id ? (p.all_sites ? 'hidden' : '') : canAll ? 'hidden' : ''}>
      ${sites.map((l) => `<label class="check-row"><input type="checkbox" name="site_pick" value="${l.id}" ${(p.site_ids ?? []).includes(l.id) ? 'checked' : ''}><span>${esc(l.name)}</span></label>`).join('')}
    </div>
    ${field('Message', textarea('body', p.body, 'rows="9" required'), { hint: 'Leave a blank line between paragraphs. Web addresses become links.' })}
    <label class="check-row"><input type="checkbox" name="pinned" ${p.pinned ? 'checked' : ''}><span><strong>Pin to the top</strong> <small>Stays above newer posts</small></span></label>
    <label class="check-row"><input type="checkbox" name="requires_ack" ${p.requires_ack ? 'checked' : ''}><span><strong>Ask people to confirm they’ve read it</strong> <small>Adds an “I’ve read this” button – good for policy updates</small></span></label>
    ${p.id && p.requires_ack ? '<label class="check-row"><input type="checkbox" name="ask_again"><span><strong>Ask everyone to read it again</strong> <small>Clears who has read it, e.g. after changing a policy</small></span></label>' : ''}`;
  const wire = (f) => {
    const aud = f.querySelector('[name=audience]');
    aud.addEventListener('change', () => { f.querySelector('.news-sites').hidden = aud.value !== 'sites'; });
  };
  const values = (v, f) => ({
    title: v.title, body: v.body, category: v.category, pinned: !!v.pinned, requires_ack: !!v.requires_ack, ask_again: !!v.ask_again,
    all_sites: v.audience === 'all',
    site_ids: [...f.querySelectorAll('[name=site_pick]:checked')].map((c) => Number(c.value)),
  });

  el.querySelector('#add').addEventListener('click', () => {
    const { form: f } = openModal({
      title: 'New post', wide: true, submitLabel: 'Post it',
      body: form({}),
      onSubmit: async (v, f2) => { await api('/news', { method: 'POST', body: values(v, f2) }); toast('Posted – it’s on everyone’s My Brew page'); rerender(); },
    });
    wire(f);
  });
  el.querySelectorAll('tr[data-edit]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const p = posts.find((x) => x.id === Number(tr.dataset.edit));
    if (!p.can_edit) return;
    const { form: f } = openModal({
      title: 'Edit post', wide: true,
      body: form(p),
      danger: 'Delete post',
      onDanger: async () => {
        await api(`/news/${p.id}`, { method: 'DELETE' }); toast('Post deleted'); rerender();
      },
      onSubmit: async (v, f2) => { await api(`/news/${p.id}`, { method: 'PUT', body: values(v, f2) }); toast('Saved'); rerender(); },
    });
    wire(f);
  }));
  el.querySelectorAll('[data-reads]').forEach((b) => b.addEventListener('click', async () => {
    const p = posts.find((x) => x.id === Number(b.dataset.reads));
    try {
      const people = await api(`/news/${p.id}/reads`);
      const done = people.filter((x) => x.read_at);
      const notYet = people.filter((x) => !x.read_at);
      openModal({
        title: `Who has read “${p.title}”`, wide: true,
        body: `<div class="reads-cols">
          <div><h3>Not yet (${notYet.length})</h3><ul class="plain-list">${notYet.map((x) => `<li>${esc(x.name)} <span class="muted small">${esc(x.location_name ?? '')}</span></li>`).join('') || '<li class="muted">Everyone has read it 🎉</li>'}</ul></div>
          <div><h3>Read (${done.length})</h3><ul class="plain-list">${done.map((x) => `<li>${esc(x.name)} <span class="muted small">${fmtDateTime(x.read_at)}</span></li>`).join('') || '<li class="muted">Nobody yet</li>'}</ul></div>
        </div>`,
      });
    } catch (err) { showError(err); }
  }));
}
