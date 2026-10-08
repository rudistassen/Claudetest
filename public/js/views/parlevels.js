import { api, confirmDialog, esc, fmtDate, fmtDateTime, qs, showError, toast } from '../lib.js';

// Reporting → Par levels: pick a Square category, then a site. Each item shows its average sold on each day of the
// week over the last 6 full weeks, with a row underneath to budget the par level for each day. Save it as a draft
// while working on it, then as the final version – which keeps just the budgeted par levels.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const num = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 10) / 10));
const sum = (list) => list.reduce((t, n) => t + (Number(n) || 0), 0);

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const sites = state.locations.filter((l) => l.active);
  const category = query.category || '';
  const site = query.site || (category ? String(state.locationId ?? sites[0]?.id ?? '') : '');
  const view = query.view === 'final' ? 'final' : 'budget';
  const data = await api(`/par-levels${qs({ category: category || undefined, location_id: category && site ? site : undefined })}`);
  if (stale()) return;
  const go = (extra) => navigate(`par-levels${qs({ category: category || undefined, site: site || undefined, view: view === 'final' ? 'final' : undefined, ...extra })}`);
  const siteName = sites.find((l) => String(l.id) === String(data.location_id))?.name ?? '';

  const filters = `<div class="filters par-filters">
      <label class="field"><span>Category</span><select id="par-cat">
        <option value="">Choose a category…</option>
        ${data.categories.map((c) => `<option ${c === data.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="field"><span>Site</span><select id="par-site" ${data.category ? '' : 'disabled'}>
        ${sites.map((l) => `<option value="${l.id}" ${String(l.id) === String(site) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      ${data.category && data.location_id ? `<div class="seg" role="group" aria-label="Budget or final version">
        <button data-view="budget" class="${view === 'budget' ? 'is-on' : ''}">Budget</button><button data-view="final" class="${view === 'final' ? 'is-on' : ''}">Final version</button></div>` : ''}
    </div>`;
  const head = `<div class="page-head"><h1>Par levels</h1>${data.category && data.location_id && view === 'final' && data.final ? '<div class="actions"><button class="btn" id="par-print">Print</button></div>' : ''}</div>`;
  const wire = () => {
    el.querySelector('#par-cat').addEventListener('change', (e) => navigate(`par-levels${qs({ category: e.target.value || undefined, site: e.target.value ? site || undefined : undefined })}`));
    el.querySelector('#par-site')?.addEventListener('change', (e) => go({ site: e.target.value }));
    el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => go({ view: b.dataset.view === 'final' ? 'final' : undefined })));
    el.querySelector('#par-print')?.addEventListener('click', () => window.print());
  };

  if (!data.category || !data.location_id) {
    el.innerHTML = `${head}
      <p class="muted">How many of each item a site should have ready each day, budgeted from what it has sold on that day of the week over the last ${data.weeks} weeks (from Square).</p>
      ${filters}
      ${!data.catalog_synced ? '<p class="notice">Square item categories haven’t been read yet. They come in with the next Square sync (Setup → Square → Sync now); the Square token needs permission to read Items.</p>' : ''}
      <div class="card empty">${data.categories.length ? 'Choose a category, then a site.' : 'No Square item sales in the last 6 weeks yet.'}</div>`;
    wire();
    return;
  }

  const period = `${fmtDate(data.from, { day: 'numeric', month: 'short' })} – ${fmtDate(data.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const savedLine = (s, what) => (s ? `<p class="muted small">${what} saved by ${esc(s.saved_by ?? 'someone')} · ${fmtDateTime(s.saved_at)}</p>` : '');

  // --- Final version: just the budgeted par levels ---
  if (view === 'final') {
    const lines = data.final?.lines ?? [];
    el.innerHTML = `${head}${filters}
      <section class="card par-final">
        <h2>${esc(data.category)} · ${esc(siteName)}</h2>
        ${data.final ? savedLine(data.final, 'Final version') : ''}
        ${lines.length ? `<div class="table-wrap"><table class="par-table">
          <thead><tr><th>Item</th>${DAYS.map((d, i) => `<th class="num" title="${LONG_DAYS[i]}">${d}</th>`).join('')}<th class="num">Week</th></tr></thead>
          <tbody>${lines.map((l) => `<tr><th scope="row">${esc(l.item_name)}</th>${l.pars.map((p) => `<td class="num"><strong>${num(p) || '–'}</strong></td>`).join('')}<td class="num">${num(sum(l.pars))}</td></tr>`).join('')}</tbody>
        </table></div>` : `<p class="muted">No final version yet. Budget the par levels on the <button class="link-btn" data-view="budget">Budget</button> tab, then save them as the final version.</p>`}
      </section>`;
    wire();
    return;
  }

  // --- Budget: average sold, with a par level row under each item ---
  const draft = new Map((data.draft?.lines ?? []).map((l) => [l.item_key, l.pars]));
  const changedSinceFinal = data.final && data.draft && data.draft.saved_at > data.final.saved_at;
  el.innerHTML = `${head}${filters}
    <p class="muted">Average sold on each day of the week over the last ${data.weeks} full weeks (${period}). Days ${esc(siteName)} didn’t trade are left out. Put the par level you want for each day in the row under each item.</p>
    ${changedSinceFinal ? '<p class="notice">The draft has changes that aren’t in the final version yet.</p>' : ''}
    ${data.items.length ? `<form id="par-form" class="card">
      <div class="table-wrap"><table class="par-table par-budget">
        <thead><tr><th>Item</th><th></th>${DAYS.map((d, i) => `<th class="num" title="${LONG_DAYS[i]} – ${data.days_traded[i]} day${data.days_traded[i] === 1 ? '' : 's'} trading">${d}</th>`).join('')}<th class="num">Week</th></tr></thead>
        ${data.items.map((it) => {
          const pars = draft.get(it.item_key) ?? Array(7).fill(null);
          return `<tbody class="par-item" data-key="${esc(it.item_key)}" data-name="${esc(it.name)}">
            <tr class="par-avg"><th scope="rowgroup" rowspan="2">${esc(it.name)}</th><td class="par-label">Avg sold</td>
              ${it.avg.map((a, i) => `<td class="num">${data.days_traded[i] ? num(a) : '<span class="muted" title="Not trading">–</span>'}</td>`).join('')}<td class="num">${num(sum(it.avg))}</td></tr>
            <tr class="par-row"><td class="par-label">Par level</td>
              ${pars.map((p, i) => `<td class="num"><input class="qty-input par-input" type="number" min="0" step="any" inputmode="decimal" data-day="${i}" data-avg="${it.avg[i]}" value="${num(p)}" aria-label="${esc(it.name)} par level on ${LONG_DAYS[i]}"></td>`).join('')}
              <td class="num par-week">${num(sum(pars))}</td></tr>
          </tbody>`;
        }).join('')}
      </table></div>
      <div class="actions">
        <button type="button" class="btn" id="par-fill" title="Puts each day’s average, rounded up, into any par level left empty">Fill empty with averages</button>
        <span class="topbar-gap"></span>
        <button type="submit" class="btn" data-save="draft">Save draft</button>
        <button type="submit" class="btn btn-primary" data-save="final">Save as final version</button>
      </div>
      ${savedLine(data.draft, 'Draft')}${savedLine(data.final, 'Final version')}
    </form>` : '<div class="card empty">Nothing in this category sold here in the last 6 weeks.</div>'}`;
  wire();
  const form = el.querySelector('#par-form');
  if (!form) return;
  const weekTotal = (body) => { body.querySelector('.par-week').textContent = num(sum([...body.querySelectorAll('.par-input')].map((i) => i.value))); };
  form.addEventListener('input', (e) => { if (e.target.matches('.par-input')) weekTotal(e.target.closest('.par-item')); });
  form.querySelector('#par-fill').addEventListener('click', () => {
    let n = 0;
    form.querySelectorAll('.par-input').forEach((i) => { if (i.value === '' && Number(i.dataset.avg) > 0) { i.value = Math.ceil(Number(i.dataset.avg)); n++; } });
    form.querySelectorAll('.par-item').forEach(weekTotal);
    toast(n ? `Filled ${n} par level${n === 1 ? '' : 's'} – check them, then save` : 'Nothing empty to fill');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const version = e.submitter?.dataset.save === 'final' ? 'final' : 'draft';
    const lines = [...form.querySelectorAll('.par-item')].map((b) => ({
      item_key: b.dataset.key, item_name: b.dataset.name,
      pars: [...b.querySelectorAll('.par-input')].map((i) => (i.value === '' ? null : Number(i.value))),
    }));
    if (version === 'final') {
      const count = lines.filter((l) => l.pars.some((p) => p > 0)).length;
      if (!count) { showError(new Error('Put in at least one par level first')); return; }
      if (!await confirmDialog(`Save ${count} item${count === 1 ? '' : 's'} as the final par levels for ${data.category} at ${siteName}?${data.final ? ' This replaces the current final version.' : ''}`, { confirmLabel: 'Save final version' })) return;
    }
    try {
      await api('/par-levels', { method: 'PUT', body: { location_id: data.location_id, category: data.category, version, lines } });
      toast(version === 'final' ? 'Saved as the final version' : 'Draft saved');
      if (version === 'final') go({ view: 'final' }); else ctx.rerender();
    } catch (err) { showError(err); }
  });
}
