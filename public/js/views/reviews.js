import { api, esc, fmtDate, openModal, qs, showError, siteFilter, siteScope, toast } from '../lib.js';

// Reporting → Reviews: each site's Google rating and its latest Google reviews.

const stars = (n) => {
  const full = Math.round(n ?? 0);
  return `<span class="stars" role="img" aria-label="${n ?? 0} out of 5 stars">${'★'.repeat(full)}<span class="stars-off">${'★'.repeat(5 - full)}</span></span>`;
};
// The latest reviews shown before "Show all".
const FIRST = 12;
const rating1 = (n) => (n === null || n === undefined ? '–' : Number(n).toFixed(1));

function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return fmtDate(iso.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' });
}

function change(site) {
  if (!site.since || site.rating === null) return '';
  const d = Math.round((site.rating - site.since.rating) * 10) / 10;
  const extra = site.review_count - site.since.review_count;
  const when = fmtDate(site.since.date, { day: 'numeric', month: 'short' });
  const tone = d > 0 ? 'tone-good' : d < 0 ? 'tone-bad' : 'muted';
  return `<small class="${tone}">${d > 0 ? '▲ +' : d < 0 ? '▼ −' : ''}${d ? Math.abs(d).toFixed(1) : 'No change'} since ${when}</small>
    ${extra > 0 ? `<small class="muted">${extra} new review${extra === 1 ? '' : 's'}</small>` : ''}`;
}

function siteCard(s, isAdmin) {
  if (!s.place_id) {
    return `<article class="card review-site review-site-empty">
      <h3>${esc(s.name)}</h3>
      <p class="muted small">Not linked to Google Maps yet.</p>
      ${isAdmin ? `<button class="btn btn-small" data-link="${s.id}">Find on Google</button>` : ''}
    </article>`;
  }
  return `<article class="card review-site">
    <h3>${esc(s.name)}${s.new_this_week ? ` <span class="badge badge-new">${s.new_this_week} new this week</span>` : ''}</h3>
    <div class="review-score"><strong>${rating1(s.rating)}</strong>${stars(s.rating)}</div>
    <p class="small">${s.review_count === null ? 'Waiting for the first check' : `${s.review_count.toLocaleString('en-GB')} Google review${s.review_count === 1 ? '' : 's'}`}</p>
    <p class="review-change">${change(s)}</p>
    <p class="review-links small">
      <a href="${esc(s.maps_url)}" target="_blank" rel="noopener">Open on Google Maps ↗</a>
      <button type="button" class="link-btn" data-copy="${esc(s.write_review_url)}" title="A link that takes customers straight to leaving a review – for receipts, QR codes or emails">Copy review link</button>
      ${isAdmin ? `<button type="button" class="link-btn" data-link="${s.id}">Change</button>` : ''}
    </p>
  </article>`;
}

function reviewItem(r, siteName, showSite, hidden = false) {
  const fresh = Date.now() - Date.parse(`${r.first_seen_at}`) < 2 * 86400000 && Date.now() - Date.parse(r.published_at ?? 0) < 7 * 86400000;
  const author = r.author_url ? `<a href="${esc(r.author_url)}" target="_blank" rel="noopener">${esc(r.author)}</a>` : esc(r.author);
  return `<li class="review ${r.rating <= 3 ? 'review-low' : ''}"${hidden ? ' hidden' : ''}>
    <div class="review-head">
      ${r.author_photo ? `<img src="${esc(r.author_photo)}" alt="" class="review-photo" referrerpolicy="no-referrer" loading="lazy">` : `<span class="review-photo review-initial">${esc((r.author || '?').slice(0, 1))}</span>`}
      <div><strong>${author}</strong>${fresh ? ' <span class="badge badge-new">New</span>' : ''}
        <div class="small">${stars(r.rating)} <span class="muted">${ago(r.published_at)}${showSite ? ` · ${esc(siteName)}` : ''}</span></div></div>
    </div>
    ${r.text ? `<p class="review-text">${esc(r.text)}</p>` : '<p class="muted small">No written review – just a star rating.</p>'}
    ${r.review_url ? `<a class="small" href="${esc(r.review_url)}" target="_blank" rel="noopener">Reply on Google ↗</a>` : ''}
  </li>`;
}

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const scope = siteScope(state, query.scope);
  const low = query.stars === 'low';
  const data = await api(`/reviews${qs({ location_id: scope === 'all' ? undefined : state.locationId })}`);
  if (stale()) return;
  const linked = data.sites.filter((s) => s.place_id && s.rating !== null);
  const total = linked.reduce((n, s) => n + (s.review_count || 0), 0);
  const average = total ? linked.reduce((n, s) => n + s.rating * (s.review_count || 0), 0) / total : null;
  const names = Object.fromEntries(data.sites.map((s) => [s.id, s.name]));
  const all = data.sites.flatMap((s) => s.reviews.map((r) => ({ ...r, site: s.id })))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  const shown = low ? all.filter((r) => r.rating <= 3) : all;
  const multi = data.sites.length > 1;

  el.innerHTML = `
    <div class="page-head">
      <h1>Reviews</h1>
      <div class="actions">${data.configured ? '<button class="btn" id="rv-sync">Check now</button>' : ''}</div>
    </div>
    <form class="filters" id="rv-filters">
      ${siteFilter(state, scope)}
      <select name="stars" aria-label="Which reviews">
        <option value="">All reviews</option>
        <option value="low" ${low ? 'selected' : ''}>3 stars or fewer</option>
      </select>
    </form>
    ${data.configured ? '' : `<section class="card review-setup">
      <h2>Connect Google reviews</h2>
      <p>To bring in each site’s Google rating and reviews, an admin creates a Google Maps API key with <strong>Places API (New)</strong> switched on and adds it in Railway as <code>GOOGLE_PLACES_API_KEY</code>. Each site is then linked to its Google Maps listing on this page.</p>
    </section>`}
    ${data.last_error ? `<p class="notice review-error">The last check had a problem: ${esc(data.last_error)}</p>` : ''}
    ${linked.length ? `<div class="kpis">
      <div class="kpi" data-icon="★"><span>${multi ? 'Average rating' : 'Rating'}</span><strong>${rating1(average)}</strong><small>${stars(average)}</small></div>
      <div class="kpi"><span>Google reviews</span><strong>${total.toLocaleString('en-GB')}</strong><small>${linked.length} site${linked.length === 1 ? '' : 's'}</small></div>
      <div class="kpi"><span>New this week</span><strong>${data.sites.reduce((n, s) => n + s.new_this_week, 0)}</strong></div>
    </div>` : ''}
    <div class="review-sites">${data.sites.map((s) => siteCard(s, state.isAdmin)).join('')}</div>
    <section class="card">
      <div class="card-head"><h2>Latest reviews</h2><span class="muted small">from Google${data.last_sync ? ` · checked ${ago(data.last_sync)}` : ''}</span></div>
      ${shown.length ? `<ul class="review-list">${shown.map((r, i) => reviewItem(r, names[r.site], multi, i >= FIRST)).join('')}</ul>
        ${shown.length > FIRST ? `<button type="button" class="btn btn-small review-more" id="rv-more">Show all ${shown.length} reviews</button>` : ''}`
        : `<p class="muted">${low && all.length ? 'No reviews of 3 stars or fewer – nice.' : 'No reviews yet.'}</p>`}
      <p class="muted small">Google shares each place’s five most relevant recent reviews at a time, so Brewly shows the ones it has seen over the last month. To see every review or reply, open the site on Google Maps.</p>
    </section>`;

  const form = el.querySelector('#rv-filters');
  form.addEventListener('submit', (e) => { e.preventDefault(); navigate(`reviews${qs({ scope: form.scope?.value, stars: form.stars.value || undefined })}`); });
  form.stars.addEventListener('change', () => form.requestSubmit());

  el.querySelector('#rv-sync')?.addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = 'Checking…';
    try {
      const r = await api('/reviews/sync', { method: 'POST' });
      if (r.recent) toast('Checked in the last few minutes – showing the latest');
      else if (r.errors.length) toast(r.errors[0], 'error');
      else toast(r.new_reviews ? `${r.new_reviews} new review${r.new_reviews === 1 ? '' : 's'}` : 'No new reviews');
      ctx.rerender();
    } catch (err) { showError(err); b.disabled = false; b.textContent = 'Check now'; }
  });
  el.querySelector('#rv-more')?.addEventListener('click', (e) => {
    el.querySelectorAll('.review[hidden]').forEach((li) => { li.hidden = false; });
    e.target.remove();
  });
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Review link copied'); } catch { window.prompt('Copy this link:', b.dataset.copy); }
  }));
  el.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => {
    const site = data.sites.find((s) => s.id === Number(b.dataset.link));
    linkSite(ctx, site, data.configured);
  }));
}

function linkSite(ctx, site, configured) {
  const loc = ctx.state.locations.find((l) => l.id === site.id);
  let results = [];
  let chosen = null;
  const { form } = openModal({
    title: `Find ${site.name} on Google`,
    submitLabel: 'Link this place',
    danger: site.place_id ? 'Unlink' : null,
    body: configured ? `
      <div class="row place-search">
        <label class="field"><span>Search Google Maps</span><input name="q" value="${esc([site.name, loc?.address?.split('\n')[0]].filter(Boolean).join(' '))}"></label>
        <button type="button" class="btn" id="place-find">Search</button>
      </div>
      <ul class="place-results"></ul>
      <p class="muted small">Can’t find it? Search with the café’s name and postcode, as it appears on Google Maps.</p>`
      : '<p>Add <code>GOOGLE_PLACES_API_KEY</code> in Railway first, then come back here to link each site.</p>',
    onSubmit: configured ? async () => {
      if (!chosen) throw new Error('Pick the right place from the list');
      await api(`/locations/${site.id}/google-place`, { method: 'PUT', body: { place_id: chosen } });
      toast(`${site.name} linked to Google`);
      ctx.rerender();
    } : null,
    onDanger: async () => {
      await api(`/locations/${site.id}/google-place`, { method: 'PUT', body: { place_id: null } });
      toast(`${site.name} unlinked`);
      ctx.rerender();
    },
  });
  if (!configured) return;
  const list = form.querySelector('.place-results');
  const draw = () => {
    list.innerHTML = results.length ? results.map((p) => `<li><label class="place-option">
      <input type="radio" name="place" value="${esc(p.place_id)}" ${p.place_id === chosen ? 'checked' : ''}>
      <span><strong>${esc(p.name)}</strong><br><small class="muted">${esc(p.address)}</small>
      ${p.rating ? `<br><small>${stars(p.rating)} ${rating1(p.rating)} · ${p.count} reviews</small>` : ''}</span></label></li>`).join('')
      : '<li class="muted small">Nothing found – try the name and postcode.</li>';
  };
  const find = async () => {
    const q = form.q.value.trim();
    if (!q) return;
    list.innerHTML = '<li class="muted small">Searching…</li>';
    try {
      results = await api(`/reviews/places${qs({ q })}`);
      chosen = results[0]?.place_id ?? null;
      draw();
    } catch (err) { list.innerHTML = ''; showError(err); }
  };
  form.querySelector('#place-find').addEventListener('click', find);
  form.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  list.addEventListener('change', (e) => { if (e.target.name === 'place') chosen = e.target.value; });
  find();
}
