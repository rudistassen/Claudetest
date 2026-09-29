import { api, esc, field, fmtDate, fmtDateTime, input, isDemo, money, openModal, select, showError, textarea, toast, todayISO } from '../lib.js';

// --- Photos and short videos on posts ---

const MAX_VIDEO_MB = 25;
const mediaUrl = (id) => `/api/news/media/${id}`;
// The standalone demo has no real server, so its media is loaded through fetch and shown from memory.
const srcAttr = (id) => (isDemo ? `data-src="${mediaUrl(id)}"` : `src="${mediaUrl(id)}"`);
async function hydrateMedia(root) {
  if (!isDemo) return;
  for (const el of root.querySelectorAll('[data-src]')) {
    const blob = await (await fetch(el.dataset.src)).blob();
    el.src = URL.createObjectURL(blob);
    el.removeAttribute('data-src');
  }
}

function gallery(media = []) {
  if (!media.length) return '';
  return `<div class="news-media n-${Math.min(media.length, 3)}">${media.map((m) => (m.kind === 'video'
    ? `<video controls playsinline preload="metadata" ${srcAttr(m.id)}></video>`
    : `<button type="button" class="news-img" data-full="${m.id}" aria-label="Open photo"><img ${srcAttr(m.id)} alt="" loading="lazy"></button>`)).join('')}</div>`;
}

function wireGallery(root) {
  root.querySelectorAll('.news-img').forEach((b) => b.addEventListener('click', () => {
    openModal({ title: 'Photo', wide: true, body: `<img class="news-full" src="${b.querySelector('img').src}" alt="">` });
  }));
  hydrateMedia(root);
}

// Big phone photos are resized (longest side 1600px, JPEG) before uploading, so they load quickly on mobile data.
// This also turns iPhone HEIC photos into JPEGs where the browser can open them.
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`${file.name} couldn’t be opened – use a JPEG or PNG photo`));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
  r.readAsDataURL(file);
});

// My Brew: each person's own page – their details, upcoming shifts, holiday and the staff news feed.
// Setup → News is where announcements and policy updates are posted.

// --- Company documents ---

export const DOC_CATEGORIES = { handbook: 'Handbooks', policy: 'Policies', guide: 'Guides & training', form: 'Forms', other: 'Other' };
const DOC_ICONS = [[/pdf/, '📕'], [/word|msword/, '📘'], [/sheet|excel/, '📗'], [/presentation|powerpoint/, '📙'], [/image/, '🖼️'], [/text/, '📄']];
const docIcon = (type) => DOC_ICONS.find(([re]) => re.test(type))?.[1] ?? '📄';
const fileSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const docUrl = (d, download = false) => `/api/documents/${d.id}/file${download ? '?download=1' : ''}`;
function docItem(d) {
  return `<li>
    <span class="doc-icon" aria-hidden="true">${docIcon(d.file_type)}</span>
    <span class="doc-text"><a href="${docUrl(d)}" target="_blank" rel="noopener" data-doc="${d.id}" data-name="${esc(d.file_name)}">${esc(d.title)}</a>
      ${d.description ? `<small class="muted">${esc(d.description)}</small>` : ''}
      <small class="muted">${fileSize(d.size)} · ${d.updated_at ? 'updated' : 'added'} ${fmtDate((d.updated_at ?? d.created_at).slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}</small></span>
    <a class="doc-dl" href="${docUrl(d, true)}" data-doc="${d.id}" data-name="${esc(d.file_name)}" data-download="1" title="Download" aria-label="Download ${esc(d.title)}">⤓</a>
  </li>`;
}
// In the standalone demo there's no server for the browser to open files from, so they're downloaded from memory.
function wireDocLinks(root) {
  if (!isDemo) return;
  root.querySelectorAll('[data-doc]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const blob = await (await fetch(`/api/documents/${a.dataset.doc}/file?download=1`)).blob();
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: a.dataset.name });
    document.body.append(link);
    link.click();
    link.remove();
  }));
}

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
  const [shifts, leave, news, docs] = await Promise.all([api('/my-shifts'), api('/leave/mine'), api('/news'), api('/documents')]);
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
      <header class="post-head">
        <span class="ring ${p.requires_ack && !p.read ? '' : 'is-seen'}" aria-hidden="true"><span>${esc(initials(p.author || 'BrewView'))}</span></span>
        <span class="post-who"><strong>${esc(p.author || 'BrewView')}</strong>
          <span class="muted">${fmtDate(p.created_at.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}${p.updated_at ? ' · updated' : ''}</span></span>
        ${p.pinned ? '<span class="news-pin" title="Pinned">📌 Pinned</span>' : ''}
      </header>
      <p class="news-tag-row"><span class="news-tag ${CATEGORIES[p.category][1]}">${CATEGORIES[p.category][0]}</span></p>
      ${gallery(p.media)}
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
          <span class="ring" aria-hidden="true"><span class="my-avatar">${esc(initials(u.name))}</span></span>
          <div>
            <h2>${esc(u.name)}</h2>
            <p class="muted">${esc([u.rota_group, u.access_name ?? u.role].filter(Boolean).join(' · '))}</p>
          </div>
          <div class="my-stats">
            <p><strong>${shifts.length}</strong><span>shift${shifts.length === 1 ? '' : 's'} coming up</span></p>
            <p><strong>${Math.round(weekHours * 10) / 10}</strong><span>hours this week</span></p>
            <p><strong>${leave.booked_this_year}</strong><span>holiday days</span></p>
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
        <section class="card my-docs">
          <h2>Company documents</h2>
          ${docs.length > 6 ? '<input type="search" id="doc-search" placeholder="Find a document…" aria-label="Find a document">' : ''}
          ${docs.length ? Object.entries(DOC_CATEGORIES).filter(([k]) => docs.some((d) => d.category === k)).map(([k, label]) => `
            <div class="doc-group"><h3>${label}</h3>
              <ul class="doc-list">${docs.filter((d) => d.category === k).map(docItem).join('')}</ul></div>`).join('')
            : '<p class="muted small">No documents shared yet.</p>'}
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
  wireGallery(el);
  wireDocLinks(el);
  el.querySelector('#doc-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    el.querySelectorAll('.doc-list li').forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
    el.querySelectorAll('.doc-group').forEach((g) => { g.hidden = ![...g.querySelectorAll('li')].some((li) => !li.hidden); });
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
          <td><strong>${esc(p.title)}</strong>${p.pinned ? ' <span class="small">📌</span>' : ''}${p.media.length ? ` <span class="small muted">· ${p.media.length} photo${p.media.length === 1 ? '' : 's'}/video${p.media.length === 1 ? '' : 's'}</span>` : ''}</td>
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
    <div class="field"><span>Photos and videos</span>
      <div class="media-picker" id="media-list"></div>
      <label class="btn btn-small" for="media-file">+ Add photos or videos</label>
      <input type="file" id="media-file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple hidden>
      <small class="muted">Photos are resized for you. Videos up to ${MAX_VIDEO_MB} MB – about 30–60 seconds from a phone.</small>
    </div>
    <label class="check-row"><input type="checkbox" name="pinned" ${p.pinned ? 'checked' : ''}><span><strong>Pin to the top</strong> <small>Stays above newer posts</small></span></label>
    <label class="check-row"><input type="checkbox" name="requires_ack" ${p.requires_ack ? 'checked' : ''}><span><strong>Ask people to confirm they’ve read it</strong> <small>Adds an “I’ve read this” button – good for policy updates</small></span></label>
    ${p.id && p.requires_ack ? '<label class="check-row"><input type="checkbox" name="ask_again"><span><strong>Ask everyone to read it again</strong> <small>Clears who has read it, e.g. after changing a policy</small></span></label>' : ''}`;
  // The photos/videos on the post being written: [{ id, kind, file_type }] plus uploads in progress.
  let media = [];
  let uploading = 0;
  const wire = (f, p) => {
    const aud = f.querySelector('[name=audience]');
    aud.addEventListener('change', () => { f.querySelector('.news-sites').hidden = aud.value !== 'sites'; });
    media = [...(p.media ?? [])];
    uploading = 0;
    const list = f.querySelector('#media-list');
    const show = () => {
      list.innerHTML = media.map((m, i) => `<div class="media-thumb ${m.error ? 'is-failed' : ''}">
        ${m.pending ? `<span class="media-state">${m.error ? esc(m.error) : 'Uploading…'}</span>`
          : m.kind === 'video' ? `<video ${srcAttr(m.id)} preload="metadata" muted playsinline></video><span class="media-kind">▶ Video</span>` : `<img ${srcAttr(m.id)} alt="">`}
        <button type="button" class="media-remove" data-remove="${i}" aria-label="Remove">×</button></div>`).join('');
      list.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { media.splice(Number(b.dataset.remove), 1); show(); }));
      hydrateMedia(list);
    };
    show();
    f.querySelector('#media-file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const file of files) {
        const item = { pending: true };
        media.push(item);
        uploading++;
        show();
        try {
          const isVideo = file.type.startsWith('video/');
          if (!isVideo && !file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) throw new Error('Not a photo or video');
          if (isVideo && file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`Over ${MAX_VIDEO_MB} MB – try a shorter clip`);
          const ready = isVideo ? file : await shrinkImage(file);
          const saved = await api('/news/media', { method: 'POST', body: { file_name: ready.name, media_type: ready.type, data: await toBase64(ready) } });
          Object.assign(item, saved, { pending: false });
        } catch (err) {
          item.error = `${file.name}: ${err.message}`;
        }
        uploading--;
        show();
      }
    });
  };
  const values = (v, f) => ({
    media_ids: media.filter((m) => m.id).map((m) => m.id),
    title: v.title, body: v.body, category: v.category, pinned: !!v.pinned, requires_ack: !!v.requires_ack, ask_again: !!v.ask_again,
    all_sites: v.audience === 'all',
    site_ids: [...f.querySelectorAll('[name=site_pick]:checked')].map((c) => Number(c.value)),
  });

  el.querySelector('#add').addEventListener('click', () => {
    const { form: f } = openModal({
      title: 'New post', wide: true, submitLabel: 'Post it',
      body: form({}),
      onSubmit: async (v, f2) => {
        if (uploading) throw new Error('Wait for the photos and videos to finish uploading');
        await api('/news', { method: 'POST', body: values(v, f2) }); toast('Posted – it’s on everyone’s My Brew page'); rerender();
      },
    });
    wire(f, {});
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
      onSubmit: async (v, f2) => {
        if (uploading) throw new Error('Wait for the photos and videos to finish uploading');
        await api(`/news/${p.id}`, { method: 'PUT', body: values(v, f2) }); toast('Saved'); rerender();
      },
    });
    wire(f, p);
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

// --- Setup → Documents ---

const DOC_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png';
const MAX_DOC_MB = 20;

export async function renderDocumentsSetup(ctx) {
  const { el, state, stale, rerender } = ctx;
  const docs = await api('/documents/manage');
  if (stale()) return;
  const sites = state.locations.filter((l) => l.active);
  const canAll = state.isAdmin || !!state.user.all_sites;
  const siteNames = (d) => (d.all_sites ? 'Every site' : d.site_ids.map((id) => sites.find((l) => l.id === id)?.name ?? '').filter(Boolean).join(', '));

  el.innerHTML = `
    <div class="page-head">
      <h1>Documents</h1>
      <div class="actions"><button class="btn btn-primary" id="add">+ Add document</button></div>
    </div>
    <p class="muted">Handbooks, policies, guides and forms for the <strong>Company documents</strong> list on everyone’s <a href="#/mybrew">My Brew</a> page. To tell people about a new or changed policy, post it in <a href="#/admin/news">News</a> too.</p>
    <section class="card">
      ${docs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Document</th><th>Type</th><th>Who sees it</th><th>File</th><th>Added</th></tr></thead>
        <tbody>${docs.map((d) => `<tr class="${d.can_edit ? 'clickable' : ''}" data-edit="${d.id}">
          <td><strong>${esc(d.title)}</strong>${d.description ? `<br><span class="small muted">${esc(d.description)}</span>` : ''}</td>
          <td>${DOC_CATEGORIES[d.category]}</td>
          <td class="small">${esc(siteNames(d))}</td>
          <td class="small">${docIcon(d.file_type)} <a href="${docUrl(d)}" target="_blank" rel="noopener" data-doc="${d.id}" data-name="${esc(d.file_name)}">${esc(d.file_name)}</a><br><span class="muted">${fileSize(d.size)}</span></td>
          <td class="small muted">${fmtDateTime(d.updated_at ?? d.created_at)}${d.author ? `<br>${esc(d.author)}` : ''}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No documents yet. Click <strong>+ Add document</strong> to share your first handbook or policy.</div>'}
    </section>`;
  wireDocLinks(el);

  const form = (d) => `
    ${field('Title', input('title', d.title, 'required maxlength="150" placeholder="e.g. Staff handbook 2026"'))}
    <div class="row">
      ${field('Type', select('category', [['handbook', 'Handbook'], ['policy', 'Policy'], ['guide', 'Guide or training'], ['form', 'Form'], ['other', 'Other']], d.category ?? 'policy'))}
      <div class="field"><span>Who sees it</span>
        ${select('audience', [...(canAll ? [['all', 'Every site']] : []), ['sites', 'Only the sites ticked below']], d.id ? (d.all_sites ? 'all' : 'sites') : canAll ? 'all' : 'sites')}
      </div>
    </div>
    <div class="site-picks doc-sites" ${d.id ? (d.all_sites ? 'hidden' : '') : canAll ? 'hidden' : ''}>
      ${sites.map((l) => `<label class="check-row"><input type="checkbox" name="site_pick" value="${l.id}" ${(d.site_ids ?? []).includes(l.id) ? 'checked' : ''}><span>${esc(l.name)}</span></label>`).join('')}
    </div>
    ${field('Short description (optional)', input('description', d.description, 'maxlength="1000" placeholder="What it covers, who it’s for"'))}
    <div class="field"><span>${d.id ? 'Replace the file (optional)' : 'File'}</span>
      <input type="file" name="upload" accept="${DOC_TYPES}" ${d.id ? '' : 'required'}>
      <small class="muted">${d.id ? `Now: ${esc(d.file_name)} (${fileSize(d.size)}). ` : ''}PDF, Word, Excel, PowerPoint, text or pictures, up to ${MAX_DOC_MB} MB.</small>
    </div>`;
  const wire = (f) => {
    const aud = f.querySelector('[name=audience]');
    aud.addEventListener('change', () => { f.querySelector('.doc-sites').hidden = aud.value !== 'sites'; });
    // Fill in the title from the file name when it's empty.
    f.querySelector('[name=upload]').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && !f.title.value.trim()) f.title.value = file.name.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ');
    });
  };
  const values = async (v, f) => {
    const out = {
      title: v.title, description: v.description, category: v.category,
      all_sites: v.audience === 'all',
      site_ids: [...f.querySelectorAll('[name=site_pick]:checked')].map((c) => Number(c.value)),
    };
    const file = f.querySelector('[name=upload]').files[0];
    if (file) {
      if (file.size > MAX_DOC_MB * 1024 * 1024) throw new Error(`That file is over ${MAX_DOC_MB} MB`);
      Object.assign(out, { file_name: file.name, media_type: file.type, data: await toBase64(file) });
    }
    return out;
  };

  el.querySelector('#add').addEventListener('click', () => {
    const { form: f } = openModal({
      title: 'Add a document', wide: true, submitLabel: 'Share it',
      body: form({}),
      onSubmit: async (v, f2) => { await api('/documents', { method: 'POST', body: await values(v, f2) }); toast('Shared – it’s on everyone’s My Brew page'); rerender(); },
    });
    wire(f);
  });
  el.querySelectorAll('tr[data-edit]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const d = docs.find((x) => x.id === Number(tr.dataset.edit));
    if (!d.can_edit) return;
    const { form: f } = openModal({
      title: 'Edit document', wide: true,
      body: form(d),
      danger: 'Delete document',
      onDanger: async () => { await api(`/documents/${d.id}`, { method: 'DELETE' }); toast('Document deleted'); rerender(); },
      onSubmit: async (v, f2) => { await api(`/documents/${d.id}`, { method: 'PUT', body: await values(v, f2) }); toast('Saved'); rerender(); },
    });
    wire(f);
  }));
}
