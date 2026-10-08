import { api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, showError, toast } from '../lib.js';

// Reporting → Par levels: two tiles – create a new par level report, or view the saved ones.
// Create: pick a Square category, then a site. Each item shows its average sold on each day of the week over the
// last 6 full weeks, with a row underneath to budget the par level for each day; then save it with a name. A saved
// report keeps just the budgeted par levels, and can be opened, changed, printed or deleted.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const num = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 10) / 10));
const sum = (list) => list.reduce((t, n) => t + (Number(n) || 0), 0);

// --- Par levels: the two tiles ---
export async function render(ctx) {
  const { el, stale } = ctx;
  const saved = await api('/par-levels/reports').catch(() => []);
  if (stale()) return;
  el.innerHTML = `<div class="page-head"><h1>Par levels</h1></div>
    <p class="muted">How many of each item a site should have ready each day, budgeted from what it has sold on that day of the week (from Square).</p>
    <div class="hub-tiles" data-tone="reporting">
      <a class="hub-tile" href="#/par-levels/new"><span class="hub-icon" aria-hidden="true">＋</span>
        <span class="hub-text"><strong>Create a new par level report</strong><small>Average sold Monday to Sunday over the last 6 weeks – budget each day and save it</small></span><span class="hub-go" aria-hidden="true">›</span></a>
      <a class="hub-tile" href="#/par-levels/saved"><span class="hub-icon" aria-hidden="true">▤</span>
        <span class="hub-text"><strong>View saved par levels</strong><small>${saved.length ? `${saved.length} saved report${saved.length === 1 ? '' : 's'}` : 'None saved yet'}</small></span><span class="hub-go" aria-hidden="true">›</span></a>
    </div>`;
}

// --- Create (or change a saved report: ?report=id) ---
export async function renderNew(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  const sites = state.locations.filter((l) => l.active);
  const editing = query.report ? await api(`/par-levels/reports/${Number(query.report)}`).catch(() => null) : null;
  if (stale()) return;
  const category = editing?.category ?? (query.category || '');
  const site = editing ? String(editing.location_id) : query.site || (category ? String(state.locationId ?? sites[0]?.id ?? '') : '');
  const data = await api(`/par-levels${qs({ category: category || undefined, location_id: category && site ? site : undefined, report: editing?.id })}`);
  if (stale()) return;
  const go = (extra) => navigate(`par-levels/new${qs({ category: category || undefined, site: site || undefined, ...extra })}`);
  const siteName = sites.find((l) => String(l.id) === String(data.location_id))?.name ?? '';

  const head = `<div class="page-head"><h1>${editing ? `Change “${esc(editing.name)}”` : 'New par level report'}</h1>
      <div class="actions"><a class="btn" href="#/par-levels/saved">Saved par levels</a></div></div>`;
  const filters = `<div class="filters par-filters">
      <label class="field"><span>Category</span><select id="par-cat" ${editing ? 'disabled' : ''}>
        <option value="">Choose a category…</option>
        ${data.categories.map((c) => `<option ${c === data.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="field"><span>Site</span><select id="par-site" ${data.category && !editing ? '' : 'disabled'}>
        ${sites.map((l) => `<option value="${l.id}" ${String(l.id) === String(site) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    </div>`;
  const wire = () => {
    el.querySelector('#par-cat').addEventListener('change', (e) => navigate(`par-levels/new${qs({ category: e.target.value || undefined, site: e.target.value ? site || undefined : undefined })}`));
    el.querySelector('#par-site').addEventListener('change', (e) => go({ site: e.target.value }));
  };

  if (!data.category || !data.location_id) {
    el.innerHTML = `${head}${filters}
      ${!data.catalog_synced ? '<p class="notice">Square item categories haven’t been read yet. They come in with the next Square sync (Setup → Square → Sync now); the Square token needs permission to read Items.</p>' : ''}
      <div class="card empty">${data.categories.length ? 'Choose a category, then a site.' : 'No Square item sales in the last 6 weeks yet.'}</div>`;
    wire();
    return;
  }

  const period = `${fmtDate(data.from, { day: 'numeric', month: 'short' })} – ${fmtDate(data.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const had = new Map((data.report?.lines ?? []).map((l) => [l.item_key, l.pars]));
  el.innerHTML = `${head}${filters}
    <p class="muted">Average sold on each day of the week over the last ${data.weeks} full weeks (${period}). Days ${esc(siteName)} didn’t trade are left out. Put the par level you want for each day in the row under each item.</p>
    ${data.items.length ? `<form id="par-form" class="card">
      <div class="actions par-tools">
        <button type="button" class="btn" id="par-fill">Fill budget with average sold</button>
        <button type="button" class="btn btn-ghost" id="par-clear">Clear</button>
      </div>
      <div class="table-wrap"><table class="par-table par-budget">
        <thead><tr><th>Item</th><th></th>${DAYS.map((d, i) => `<th class="num" title="${LONG_DAYS[i]} – ${data.days_traded[i]} day${data.days_traded[i] === 1 ? '' : 's'} trading">${d}</th>`).join('')}<th class="num">Week</th></tr></thead>
        ${data.items.map((it) => {
          const pars = had.get(it.item_key) ?? Array(7).fill(null);
          return `<tbody class="par-item" data-key="${esc(it.item_key)}" data-name="${esc(it.name)}">
            <tr class="par-avg"><th scope="rowgroup" rowspan="2">${esc(it.name)}</th><td class="par-label">Avg sold</td>
              ${it.avg.map((a, i) => `<td class="num">${data.days_traded[i] ? num(a) : '<span class="muted" title="Not trading">–</span>'}</td>`).join('')}<td class="num">${num(sum(it.avg))}</td></tr>
            <tr class="par-row"><td class="par-label">Budget</td>
              ${pars.map((p, i) => `<td class="num"><input class="qty-input par-input" type="number" min="0" step="any" inputmode="decimal" data-day="${i}" data-avg="${it.avg[i]}" value="${num(p)}" aria-label="${esc(it.name)} par level on ${LONG_DAYS[i]}"></td>`).join('')}
              <td class="num par-week">${num(sum(pars))}</td></tr>
          </tbody>`;
        }).join('')}
      </table></div>
      <div class="actions">
        <span class="topbar-gap"></span>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Save par levels'}</button>
      </div>
    </form>` : '<div class="card empty">Nothing in this category sold here in the last 6 weeks.</div>'}`;
  wire();
  const form = el.querySelector('#par-form');
  if (!form) return;
  const inputs = () => [...form.querySelectorAll('.par-input')];
  const weekTotal = (body) => { body.querySelector('.par-week').textContent = num(sum([...body.querySelectorAll('.par-input')].map((i) => i.value))); };
  form.addEventListener('input', (e) => { if (e.target.matches('.par-input')) weekTotal(e.target.closest('.par-item')); });
  // Every day's budget becomes that day's average sold, rounded up to a whole one.
  form.querySelector('#par-fill').addEventListener('click', async () => {
    if (inputs().some((i) => i.value !== '') && !await confirmDialog('Replace the budget you’ve put in with the average sold for each day (rounded up)?', { confirmLabel: 'Fill with average sold' })) return;
    inputs().forEach((i) => { i.value = Number(i.dataset.avg) > 0 ? Math.ceil(Number(i.dataset.avg)) : ''; });
    form.querySelectorAll('.par-item').forEach(weekTotal);
    toast('Budget filled with the average sold – change any you like, then save');
  });
  form.querySelector('#par-clear').addEventListener('click', async () => {
    if (!inputs().some((i) => i.value !== '') || !await confirmDialog('Clear every par level on this page?', { confirmLabel: 'Clear' })) return;
    inputs().forEach((i) => { i.value = ''; });
    form.querySelectorAll('.par-item').forEach(weekTotal);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const lines = [...form.querySelectorAll('.par-item')].map((b) => ({
      item_key: b.dataset.key, item_name: b.dataset.name,
      pars: [...b.querySelectorAll('.par-input')].map((i) => (i.value === '' ? null : Number(i.value))),
    }));
    const count = lines.filter((l) => l.pars.some((p) => p !== null)).length;
    if (!count) { showError(new Error('Put in at least one par level first – or use “Fill budget with average sold”')); return; }
    const suggested = editing?.name ?? `${data.category} – ${siteName} – ${fmtDate(new Date().toISOString().slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    openModal({
      title: editing ? 'Save changes' : 'Save par levels',
      body: `${field('Name', input('name', suggested, 'required maxlength="120"'))}
        <p class="muted small">${count} item${count === 1 ? '' : 's'} · ${esc(data.category)} · ${esc(siteName)}. Only the par levels you’ve budgeted are saved.</p>
        ${editing ? '<label class="check-row"><input type="checkbox" name="as_new"><span>Save as a new report (keep the old one as it is)</span></label>' : ''}`,
      submitLabel: 'Save',
      onSubmit: async (v) => {
        if (!v.name?.trim()) throw new Error('Give it a name');
        const body = { name: v.name.trim(), location_id: data.location_id, category: data.category, lines };
        const r = editing && !v.as_new
          ? await api(`/par-levels/reports/${editing.id}`, { method: 'PUT', body })
          : await api('/par-levels/reports', { method: 'POST', body });
        toast(`Saved “${r.name}”`);
        navigate(`par-levels/saved/${r.id}`);
      },
    });
  });
}

// --- Saved par levels: the list ---
export async function renderSaved(ctx) {
  const { el, stale } = ctx;
  const list = await api('/par-levels/reports');
  if (stale()) return;
  el.innerHTML = `<div class="page-head"><h1>Saved par levels</h1>
      <div class="actions"><a class="btn btn-primary" href="#/par-levels/new">+ New par level report</a></div></div>
    ${list.length ? `<section class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Category</th><th>Site</th><th class="num">Items</th><th>Saved</th></tr></thead>
      <tbody>${list.map((r) => `<tr class="clickable" data-open="${r.id}">
        <td><a href="#/par-levels/saved/${r.id}"><strong>${esc(r.name)}</strong></a></td><td>${esc(r.category)}</td><td>${esc(r.location_name)}</td>
        <td class="num">${r.items}</td><td class="small">${fmtDateTime(r.updated_at)}${r.updated_by ? ` · ${esc(r.updated_by)}` : ''}</td></tr>`).join('')}</tbody>
    </table></div></section>` : '<div class="card empty">No saved par levels yet. <a href="#/par-levels/new">Create a new par level report</a>.</div>'}`;
  el.querySelectorAll('[data-open]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = `#/par-levels/saved/${tr.dataset.open}`; }));
}

// --- One saved report: just the budgeted par levels ---
export async function renderReport(ctx) {
  const { el, params, stale, navigate } = ctx;
  let r;
  try { r = await api(`/par-levels/reports/${Number(params[0])}`); } catch (err) {
    if (stale()) return;
    el.innerHTML = `<div class="card empty">${esc(err.message)} <a href="#/par-levels/saved">Back to saved par levels</a></div>`;
    return;
  }
  if (stale()) return;
  el.innerHTML = `<div class="page-head"><div><h1>${esc(r.name)}</h1><p class="muted">${esc(r.category)} · ${esc(r.location_name)}</p></div>
      <div class="actions">
        <a class="btn" href="#/par-levels/saved">All saved</a>
        <button class="btn" id="par-print">Print</button>
        <a class="btn" href="#/par-levels/new?report=${r.id}">Change</a>
        <button class="btn btn-ghost" id="par-delete">Delete</button>
      </div></div>
    <section class="card par-final">
      <div class="table-wrap"><table class="par-table">
        <thead><tr><th>Item</th>${DAYS.map((d, i) => `<th class="num" title="${LONG_DAYS[i]}">${d}</th>`).join('')}<th class="num">Week</th></tr></thead>
        <tbody>${r.lines.map((l) => `<tr><th scope="row">${esc(l.item_name)}</th>${l.pars.map((p) => `<td class="num"><strong>${num(p) || '–'}</strong></td>`).join('')}<td class="num">${num(sum(l.pars))}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Saved by ${esc(r.updated_by ?? r.created_by ?? 'someone')} · ${fmtDateTime(r.updated_at)}</p>
    </section>`;
  el.querySelector('#par-print').addEventListener('click', () => window.print());
  el.querySelector('#par-delete').addEventListener('click', async () => {
    if (!await confirmDialog(`Delete “${r.name}”? This can’t be undone.`, { confirmLabel: 'Delete' })) return;
    try { await api(`/par-levels/reports/${r.id}`, { method: 'DELETE' }); toast('Deleted'); navigate('par-levels/saved'); } catch (err) { showError(err); }
  });
}
