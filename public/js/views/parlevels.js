import { cellRef, saveFile, workbook } from '../excel.js';
import { addDays, api, confirmDialog, esc, field, fmtDate, fmtDateTime, input, openModal, qs, showError, todayISO, toast, weekStart } from '../lib.js';

// Reporting → Par levels: two tiles – create a new par level report, or view the saved ones.
// Create: pick a Square category, then a site. Each item shows its average sold on each day of the week over the
// dates picked at the top (the last 6 full weeks to start with), with a row underneath to budget the par level for each day; then save it with a name. A saved
// report keeps just the budgeted par levels, and can be opened, changed, printed or deleted.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const num = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 10) / 10));
const sum = (list) => list.reduce((t, n) => t + (Number(n) || 0), 0);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fileName = (name) => `${name.replace(/[–—]/g, '-').replace(/[\\/:*?"<>|]+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim() || 'Par levels'}.xlsx`;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
// A week total and a column total in the spreadsheet, as formulas (with today's figures shown until Excel works them out).
const weekSum = (row, value) => ({ f: `SUM(${cellRef(2, row)}:${cellRef(8, row)})`, v: value });
// Quick ranges: the last few full weeks, Monday to Sunday.
const lastWeeks = (n) => { const to = addDays(weekStart(todayISO()), -1); return { from: addDays(to, -(n * 7 - 1)), to }; };
const range = (from, to) => `${fmtDate(from, { day: 'numeric', month: 'short', ...(from.slice(0, 4) === to.slice(0, 4) ? {} : { year: 'numeric' }) })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;

// A column heading that sorts the table: Item (A–Z) or a day / the week (biggest first; tap again to flip).
const sortHead = (key, label, title = '') => `<th class="${key === 'name' ? '' : 'num'}" aria-sort="none"><button type="button" class="th-sort" data-sort="${key}" ${title ? `title="${esc(title)}"` : ''}>${label}</button></th>`;
/** rows(): the row elements to move; value(row, key): what to sort by; key 'name' sorts A–Z. */
function makeSortable(table, rows, value) {
  let current = null;
  let dir = 1;
  table.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    dir = current === key ? -dir : key === 'name' ? 1 : -1;
    current = key;
    const list = rows();
    const parent = list[0]?.parentNode;
    if (!parent) return;
    list.sort((a, c) => {
      const x = value(a, key);
      const y = value(c, key);
      return (key === 'name' ? String(x).localeCompare(String(y)) : (Number(x) || 0) - (Number(y) || 0)) * dir
        || String(value(a, 'name')).localeCompare(String(value(c, 'name')));
    });
    const foot = table.tFoot;
    for (const r of list) (r.tagName === 'TBODY' ? table : parent).insertBefore(r, r.tagName === 'TBODY' ? foot : null);
    table.querySelectorAll('th[aria-sort]').forEach((th) => th.setAttribute('aria-sort', 'none'));
    b.closest('th').setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
  }));
}

// --- Par levels: the two tiles ---
export async function render(ctx) {
  const { el, stale } = ctx;
  const saved = await api('/par-levels/reports').catch(() => []);
  if (stale()) return;
  el.innerHTML = `<div class="page-head"><h1>Par levels</h1></div>
    <p class="muted">How many of each item a site should have ready each day, budgeted from what it has sold on that day of the week (from Square).</p>
    <div class="hub-tiles" data-tone="reporting">
      <a class="hub-tile" href="#/par-levels/new"><span class="hub-icon" aria-hidden="true">＋</span>
        <span class="hub-text"><strong>Create a new par level report</strong><small>Average sold Monday to Sunday over the dates you pick – budget each day and save it</small></span><span class="hub-go" aria-hidden="true">›</span></a>
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
  const from = ISO.test(query.from ?? '') ? query.from : editing?.sales_from ?? undefined;
  const to = ISO.test(query.to ?? '') ? query.to : editing?.sales_to ?? undefined;
  let data;
  try {
    data = await api(`/par-levels${qs({ category: category || undefined, location_id: category && site ? site : undefined, report: editing?.id, from, to })}`);
  } catch (err) {
    if (stale()) return;
    showError(err);
    navigate(`par-levels/new${qs({ category: category || undefined, site: site || undefined, report: editing?.id })}`);
    return;
  }
  if (stale()) return;
  const go = (extra) => navigate(`par-levels/new${qs({ category: category || undefined, site: site || undefined, report: editing?.id, from: data.from, to: data.to, ...extra })}`);
  const siteName = sites.find((l) => String(l.id) === String(data.location_id))?.name ?? '';

  const head = `<div class="page-head"><h1>${editing ? `Change “${esc(editing.name)}”` : 'New par level report'}</h1>
      <div class="actions"><a class="btn" href="#/par-levels/saved">Saved par levels</a></div></div>`;
  const filters = `<div class="filters par-filters">
      <label class="field"><span>Category</span><select id="par-cat" ${editing ? 'disabled' : ''}>
        <option value="">Choose a category…</option>
        ${data.categories.map((c) => `<option ${c === data.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="field"><span>Site</span><select id="par-site" ${data.category && !editing ? '' : 'disabled'}>
        ${sites.map((l) => `<option value="${l.id}" ${String(l.id) === String(site) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    </div>
    <div class="filters par-dates">
      <label class="field"><span>Sales from</span><input type="date" id="par-from" value="${data.from}" max="${todayISO()}"></label>
      <label class="field"><span>to</span><input type="date" id="par-to" value="${data.to}" max="${todayISO()}"></label>
      <div class="par-quick" role="group" aria-label="Quick date ranges">
        ${[4, 6, 8, 12].map((n) => { const w = lastWeeks(n); return `<button type="button" class="chip-btn ${w.from === data.from && w.to === data.to ? 'is-on' : ''}" data-weeks="${n}">Last ${n} weeks</button>`; }).join('')}
      </div>
    </div>`;
  const wire = () => {
    el.querySelector('#par-cat').addEventListener('change', (e) => navigate(`par-levels/new${qs({ category: e.target.value || undefined, site: e.target.value ? site || undefined : undefined, from: data.from, to: data.to })}`));
    el.querySelector('#par-site').addEventListener('change', (e) => go({ site: e.target.value }));
    const dates = () => {
      const f = el.querySelector('#par-from').value;
      const t = el.querySelector('#par-to').value;
      if (!f || !t) return;
      if (f > t) { showError(new Error('The start date is after the end date')); return; }
      go({ from: f, to: t });
    };
    el.querySelector('#par-from').addEventListener('change', dates);
    el.querySelector('#par-to').addEventListener('change', dates);
    el.querySelectorAll('[data-weeks]').forEach((b) => b.addEventListener('click', () => go(lastWeeks(Number(b.dataset.weeks)))));
  };

  if (!data.category || !data.location_id) {
    el.innerHTML = `${head}${filters}
      ${!data.catalog_synced ? '<p class="notice">Square item categories haven’t been read yet. They come in with the next Square sync (Setup → Square → Sync now); the Square token needs permission to read Items.</p>' : ''}
      <div class="card empty">${data.categories.length ? 'Choose a category, then a site.' : 'No Square item sales in the last 6 weeks yet.'}</div>`;
    wire();
    return;
  }

  const period = range(data.from, data.to);
  const had = new Map((data.report?.lines ?? []).map((l) => [l.item_key, l.pars]));
  el.innerHTML = `${head}${filters}
    <p class="muted">Average sold on each day of the week from <strong>${period}</strong>. Days ${esc(siteName)} didn’t trade are left out. Put the par level you want for each day in the row under each item.</p>
    ${data.items.length ? `<form id="par-form" class="card">
      <div class="actions par-tools">
        <button type="button" class="btn" id="par-fill">Fill budget with average sold</button>
        <button type="button" class="btn btn-ghost" id="par-clear">Clear</button>
        <span class="topbar-gap"></span>
        <button type="button" class="btn" id="par-excel">Export to Excel</button>
      </div>
      <div class="table-wrap"><table class="par-table par-budget">
        <thead><tr>${sortHead('name', 'Item')}<th></th>${DAYS.map((d, i) => sortHead(String(i), d, `Sort by average sold on ${LONG_DAYS[i]} – ${data.days_traded[i]} day${data.days_traded[i] === 1 ? '' : 's'} trading`)).join('')}${sortHead('week', 'Week', 'Sort by average sold in the week')}</tr></thead>
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
        <tfoot>
          <tr class="par-total-avg"><th scope="rowgroup" rowspan="2">Total</th><td class="par-label">Avg sold</td>
            ${DAYS.map((d, i) => `<td class="num">${num(sum(data.items.map((it) => it.avg[i])))}</td>`).join('')}<td class="num">${num(sum(data.items.map((it) => sum(it.avg))))}</td></tr>
          <tr class="par-total-budget"><td class="par-label">Budget</td>${DAYS.map((d, i) => `<td class="num" data-total-day="${i}"></td>`).join('')}<td class="num" data-total-day="week"></td></tr>
        </tfoot>
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
  // Each item's week, and the budget totals for each day along the bottom.
  const totals = () => {
    for (let d = 0; d < 7; d++) form.querySelector(`[data-total-day="${d}"]`).textContent = num(sum(inputs().filter((i) => i.dataset.day === String(d)).map((i) => i.value)));
    form.querySelector('[data-total-day="week"]').textContent = num(sum(inputs().map((i) => i.value)));
  };
  const weekTotal = (body) => { body.querySelector('.par-week').textContent = num(sum([...body.querySelectorAll('.par-input')].map((i) => i.value))); totals(); };
  totals();
  form.addEventListener('input', (e) => { if (e.target.matches('.par-input')) weekTotal(e.target.closest('.par-item')); });
  const avgOf = new Map(data.items.map((it) => [it.item_key, it.avg]));
  makeSortable(form.querySelector('.par-table'), () => [...form.querySelectorAll('.par-item')], (b, key) => {
    if (key === 'name') return b.dataset.name;
    const avg = avgOf.get(b.dataset.key) ?? [];
    return key === 'week' ? sum(avg) : avg[Number(key)];
  });
  // Every day's budget becomes that day's average sold, rounded up to a whole one.
  form.querySelector('#par-fill').addEventListener('click', async () => {
    if (inputs().some((i) => i.value !== '') && !await confirmDialog('Replace the budget you’ve put in with the average sold for each day (rounded up)?', { confirmLabel: 'Fill with average sold' })) return;
    inputs().forEach((i) => { i.value = Number(i.dataset.avg) > 0 ? Math.ceil(Number(i.dataset.avg)) : ''; });
    form.querySelectorAll('.par-item').forEach(weekTotal);
    toast('Budget filled with the average sold – change any you like, then save');
  });
  // The page as it is (in the order it's sorted, with the budget typed so far) as an Excel file.
  form.querySelector('#par-excel').addEventListener('click', () => {
    const rows = [
      [{ v: `Par levels – ${data.category} – ${siteName}`, bold: true }],
      [`Average sold from ${period} (days the site didn’t trade left out)`],
      [],
      ['Item', '', ...LONG_DAYS, 'Week'].map((v) => ({ v, bold: true })),
    ];
    const first = rows.length;
    for (const b of form.querySelectorAll('.par-item')) {
      const avg = (avgOf.get(b.dataset.key) ?? []).map(round1);
      const pars = [...b.querySelectorAll('.par-input')].map((i) => (i.value === '' ? null : Number(i.value)));
      rows.push([{ v: b.dataset.name, bold: true }, 'Avg sold', ...avg.map((v) => ({ v, num: '0.0' })), { ...weekSum(rows.length, round1(sum(avg))), num: '0.0' }]);
      rows.push(['', 'Budget', ...pars, weekSum(rows.length, sum(pars))]);
    }
    const last = rows.length - 1;
    const total = (label, col) => ({ f: `SUMIF($B$${first + 1}:$B$${last + 1},"${label}",${cellRef(col, first)}:${cellRef(col, last)})`, bold: true,
      v: round1(sum(rows.slice(first).filter((row) => row[1] === label).map((row) => (typeof row[col] === 'object' && row[col] ? row[col].v : row[col])))) });
    rows.push([{ v: 'Total', bold: true }, { v: 'Avg sold', bold: true }, ...Array.from({ length: 8 }, (_, i) => ({ ...total('Avg sold', i + 2), num: '0.0' }))]);
    rows.push(['', { v: 'Budget', bold: true }, ...Array.from({ length: 8 }, (_, i) => total('Budget', i + 2))]);
    saveFile(fileName(`Par levels – ${data.category} – ${siteName}`), workbook('Par levels', rows, [28, 10, 11, 11, 11, 11, 11, 11, 11, 10]));
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
        <p class="muted small">${count} item${count === 1 ? '' : 's'} · ${esc(data.category)} · ${esc(siteName)} · averages from ${period}. Only the par levels you’ve budgeted are saved.</p>
        ${editing ? '<label class="check-row"><input type="checkbox" name="as_new"><span>Save as a new report (keep the old one as it is)</span></label>' : ''}`,
      submitLabel: 'Save',
      onSubmit: async (v) => {
        if (!v.name?.trim()) throw new Error('Give it a name');
        const body = { name: v.name.trim(), location_id: data.location_id, category: data.category, sales_from: data.from, sales_to: data.to, lines };
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
  el.innerHTML = `<div class="page-head"><div><h1>${esc(r.name)}</h1><p class="muted">${esc(r.category)} · ${esc(r.location_name)}${r.sales_from && r.sales_to ? ` · from sales ${range(r.sales_from, r.sales_to)}` : ''}</p></div>
      <div class="actions">
        <a class="btn" href="#/par-levels/saved">All saved</a>
        <button class="btn" id="par-print">Print</button>
        <button class="btn" id="par-excel">Export to Excel</button>
        <a class="btn" href="#/par-levels/new?report=${r.id}">Change</a>
        <button class="btn btn-ghost" id="par-delete">Delete</button>
      </div></div>
    <section class="card par-final">
      <div class="table-wrap"><table class="par-table">
        <thead><tr>${sortHead('name', 'Item')}${DAYS.map((d, i) => sortHead(String(i), d, `Sort by ${LONG_DAYS[i]}`)).join('')}${sortHead('week', 'Week', 'Sort by the week')}</tr></thead>
        <tbody>${r.lines.map((l, n) => `<tr data-line="${n}"><th scope="row">${esc(l.item_name)}</th>${l.pars.map((p) => `<td class="num"><strong>${num(p) || '–'}</strong></td>`).join('')}<td class="num">${num(sum(l.pars))}</td></tr>`).join('')}</tbody>
        <tfoot><tr class="par-total"><th scope="row">Total</th>${DAYS.map((d, i) => `<td class="num">${num(sum(r.lines.map((l) => l.pars[i])))}</td>`).join('')}<td class="num">${num(sum(r.lines.map((l) => sum(l.pars))))}</td></tr></tfoot>
      </table></div>
      <p class="muted small">Saved by ${esc(r.updated_by ?? r.created_by ?? 'someone')} · ${fmtDateTime(r.updated_at)}</p>
    </section>`;
  makeSortable(el.querySelector('.par-table'), () => [...el.querySelectorAll('tr[data-line]')], (tr, key) => {
    const l = r.lines[Number(tr.dataset.line)];
    return key === 'name' ? l.item_name : key === 'week' ? sum(l.pars) : l.pars[Number(key)] ?? -1;
  });
  el.querySelector('#par-print').addEventListener('click', () => window.print());
  // The saved par levels (in the order they're sorted) as an Excel file.
  el.querySelector('#par-excel').addEventListener('click', () => {
    const rows = [
      [{ v: r.name, bold: true }],
      [`${r.category} · ${r.location_name}${r.sales_from && r.sales_to ? ` · from sales ${range(r.sales_from, r.sales_to)}` : ''}`],
      [`Saved by ${r.updated_by ?? r.created_by ?? 'someone'} · ${fmtDateTime(r.updated_at)}`],
      [],
      ['Item', ...LONG_DAYS, 'Week'].map((v) => ({ v, bold: true })),
    ];
    const first = rows.length;
    for (const tr of el.querySelectorAll('tr[data-line]')) {
      const l = r.lines[Number(tr.dataset.line)];
      rows.push([{ v: l.item_name, bold: true }, ...l.pars, { f: `SUM(${cellRef(1, rows.length)}:${cellRef(7, rows.length)})`, v: sum(l.pars) }]);
    }
    const last = rows.length - 1;
    rows.push([{ v: 'Total', bold: true }, ...Array.from({ length: 8 }, (_, i) => ({ f: `SUM(${cellRef(i + 1, first)}:${cellRef(i + 1, last)})`, bold: true,
      v: sum(rows.slice(first).map((row) => (typeof row[i + 1] === 'object' && row[i + 1] ? row[i + 1].v : row[i + 1]))) }))]);
    saveFile(fileName(r.name), workbook('Par levels', rows, [28, 11, 11, 11, 11, 11, 11, 11, 10]));
  });
  el.querySelector('#par-delete').addEventListener('click', async () => {
    if (!await confirmDialog(`Delete “${r.name}”? This can’t be undone.`, { confirmLabel: 'Delete' })) return;
    try { await api(`/par-levels/reports/${r.id}`, { method: 'DELETE' }); toast('Deleted'); navigate('par-levels/saved'); } catch (err) { showError(err); }
  });
}
