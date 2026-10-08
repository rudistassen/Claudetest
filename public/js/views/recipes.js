import { openProductEditor } from './admin.js';
import { addDays, api, esc, field, fmtDate, input, money, qs, qty, showError, textarea, toast, todayISO, siteScope, siteFilter } from '../lib.js';

let metaCache = null;
const meta = async () => (metaCache ??= await api('/recipes/meta'));

const allergenName = (m, key) => m.allergens.find(([k]) => k === key)?.[1] ?? key;

// Short labels for chips and matrix headings; recipe cards use the full legal names.
const SHORT = { gluten: 'Gluten', nuts: 'Tree nuts', sulphites: 'Sulphites' };
const shortName = (m, key) => SHORT[key] ?? allergenName(m, key);

function gpTone(pct, target) {
  if (pct === null || pct === undefined) return '';
  return pct >= target ? 'good' : pct >= target - 5 ? 'warn' : 'bad';
}

const fmtPct = (p) => (p === null || p === undefined ? '–' : `${p.toFixed(1)}%`);

function chips(keys, m, kind = '') {
  if (!keys.length) return '<span class="muted small">None</span>';
  return `<span class="chips">${keys.map((k) => `<span class="chip ${kind}" title="${esc(allergenName(m, k))}">${esc(shortName(m, k))}</span>`).join('')}</span>`;
}

// Two kinds of recipe: sold items (on the menu, linked to Square) and prepped recipes (made in a batch with a yield,
// and used as ingredients of sold items or other prepped recipes). Each lives under its own path.
const base = (r) => (r.kind === 'prep' ? 'recipes/prep' : 'recipes');
const recipePath = (r) => `${base(r)}/${r.id}`;
// What a batch makes: "2 kg", or "4 portions".
const makes = (r) => (r.kind === 'prep' ? `${qty(r.yield_quantity)} ${r.yield_unit}` : `${qty(r.portions)} portion${r.portions === 1 ? '' : 's'}`);
// Cost of one yield unit – often fractions of a penny (e.g. per g), so shown to more places when small.
const unitPrice = (n) => (n === null || n === undefined ? '–' : n > 0 && n < 0.1 ? `£${n.toFixed(4)}` : money(n));

// --- Lists ---

export const renderPrepList = (ctx) => renderList(ctx, 'prep');

export async function renderList(ctx, kind = 'sold') {
  const { el, state, stale, query } = ctx;
  const [all, m] = await Promise.all([api('/recipes'), meta()]);
  if (stale()) return;
  const prep = kind === 'prep';
  const recipes = all.filter((r) => r.kind === kind);
  const categories = [...new Set(recipes.map((r) => r.category).filter(Boolean))];
  const cat = query.category ?? '';
  const costs = state.can('recipes.costs', 'recipes.edit');

  el.innerHTML = `
    <div class="page-head">
      <h1>${prep ? 'Prepped recipes' : 'Sold items'}</h1>
      <div class="actions">${state.can('recipes.edit') ? `<a class="btn btn-primary" href="#/${prep ? 'recipes/prep/new' : 'recipes/new'}">+ New ${prep ? 'prepped recipe' : 'sold item'}</a>` : ''}</div>
    </div>
    <p class="muted">${prep ? 'Things made in a batch – sauces, fillings, dressings, bakes – with how much each batch makes. Use them as ingredients in sold items or in other prepped recipes, and their cost and allergens carry through.'
      : 'Everything on the menu, costed from its ingredients and linked to the Square item it’s sold as.'}</p>
    <div class="filters">
      <input type="search" id="search" placeholder="Search recipes or ingredients…" aria-label="Search recipes">
      <select id="category" aria-label="Category"><option value="">All categories</option>${categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    </div>
    <section class="card">
      ${recipes.length ? `<div class="table-wrap"><table>
        <thead><tr><th>${prep ? 'Prepped recipe' : 'Item'}</th><th>Category</th>
          ${prep ? `<th class="num">Makes</th>${costs ? '<th class="num">Batch cost</th><th class="num">Cost per unit</th>' : ''}<th>Used in</th>`
            : `<th class="num">Price</th>${costs ? '<th class="num">Cost / portion</th><th class="num">GP %</th>' : ''}`}
          <th>Allergens</th>${costs && !prep ? '<th>Square</th>' : ''}</tr></thead>
        <tbody>${recipes.map((r) => `
          <tr class="clickable ${r.active ? '' : 'inactive'}" data-id="${r.id}" data-cat="${esc(r.category ?? '')}" data-search="${esc([r.name, ...(r.ingredients ?? []).map((i) => i.product_name)].join(' ').toLowerCase())}">
            <td><a href="#/${recipePath(r)}"><strong>${esc(r.name)}</strong></a>${r.missing_costs?.length ? ' <small class="tone-warn">some ingredients have no cost</small>' : ''}</td>
            <td>${esc(r.category ?? '')}</td>
            ${prep ? `<td class="num">${esc(makes(r))}</td>${costs ? `<td class="num">${money(r.batch_cost)}</td><td class="num">${unitPrice(r.cost_per_unit)} <small class="muted">/ ${esc(r.yield_unit)}</small></td>` : ''}
              <td>${r.used_in?.length ? `<small>${r.used_in.map((u) => esc(u.name)).join(', ')}</small>` : '<span class="muted small">Not used yet</span>'}</td>`
            : `<td class="num">${money(r.selling_price)}</td>${costs ? `<td class="num">${money(r.cost_per_portion)}</td><td class="num"><span class="tone-${gpTone(r.gp_pct, m.target_gp)}">${fmtPct(r.gp_pct)}</span></td>` : ''}`}
            <td>${chips(r.allergens, m)}</td>
            ${costs && !prep ? `<td>${r.square_catalog_object_id || r.square_item_name ? '<span class="badge badge-completed">Linked</span>' : '<span class="muted small">Not linked</span>'}</td>` : ''}
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">${prep ? 'No prepped recipes yet.' : 'No sold items yet.'}${state.can('recipes.edit') ? (prep ? ' Add one for anything you make in a batch, like a sauce or a filling.' : ' Add your first one to get costings and an allergen matrix.') : ''}</div>`}
      ${costs && !prep ? `<p class="muted small">GP is after VAT. Target: ${m.target_gp}% or more.</p>` : ''}
    </section>`;

  const search = el.querySelector('#search');
  const category = el.querySelector('#category');
  const apply = () => {
    const term = search.value.trim().toLowerCase();
    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.hidden = (term && !tr.dataset.search.includes(term)) || (category.value && tr.dataset.cat !== category.value);
    });
  };
  search.addEventListener('input', apply);
  category.addEventListener('change', apply);
  apply();
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => ctx.navigate(`${base({ kind })}/${tr.dataset.id}`)));
}

// --- Recipe card ---

export async function renderRecipe(ctx) {
  const { el, state, params, stale } = ctx;
  const [r, m] = await Promise.all([api(`/recipes/${params[0]}`), meta()]);
  if (stale()) return;
  const prep = r.kind === 'prep';
  const portions = prep ? 1 : r.portions || 1;
  const perPortion = (q) => q / portions;
  const costs = state.can('recipes.costs', 'recipes.edit');
  const ingName = (i) => (i.sub_recipe_id ? `<a href="#/recipes/prep/${i.sub_recipe_id}">${esc(i.product_name)}</a> <span class="badge badge-sent">Prepped</span>`
    : `${esc(i.product_name)}${i.supplier_name ? ` <small class="muted ing-supplier">${esc(i.supplier_name)}</small>` : ''}`);

  el.innerHTML = `
    <div class="page-head">
      <h1>${esc(r.name)}${r.active ? '' : ' <span class="badge">Inactive</span>'}</h1>
      <div class="actions">
        <a class="btn" href="#/${base(r)}">‹ ${prep ? 'Prepped recipes' : 'Sold items'}</a>
        ${state.can('recipes.edit') ? `<a class="btn btn-primary" href="#/${recipePath(r)}/edit">Edit</a>` : ''}
      </div>
    </div>
    <div class="kpis">
      ${prep ? `
      <div class="kpi"><span>Each batch makes</span><strong>${esc(makes(r))}</strong>${r.in_stock_takes ? '<small>Counted in stock takes</small>' : ''}</div>
      ${costs ? `<div class="kpi"><span>Batch cost</span><strong>${money(r.batch_cost)}</strong></div>
      <div class="kpi"><span>Cost per ${esc(r.yield_unit)}</span><strong>${unitPrice(r.cost_per_unit)}</strong></div>` : ''}` : `
      <div class="kpi"><span>Selling price${r.vat_rated ? ' (inc VAT)' : ' (zero-rated)'}</span><strong>${money(r.selling_price)}</strong></div>
      <div class="kpi"><span>Makes</span><strong>${esc(makes(r))}</strong></div>
      ${costs ? `
      <div class="kpi"><span>Cost per portion</span><strong>${money(r.cost_per_portion)}</strong></div>
      <div class="kpi kpi-${gpTone(r.gp_pct, m.target_gp)}"><span>GP (after VAT) · ${money(r.gp)}</span><strong>${fmtPct(r.gp_pct)}</strong></div>` : ''}`}
    </div>
    ${prep ? `<section class="card"><h2>Used in</h2>${r.used_in?.length
      ? `<ul class="plain-list">${r.used_in.map((u) => `<li><a href="#/${recipePath(u)}">${esc(u.name)}</a> <span class="muted small">${u.kind === 'prep' ? 'prepped recipe' : 'sold item'}</span></li>`).join('')}</ul>`
      : '<p class="muted">Not used in any recipe yet – add it as an ingredient when editing a sold item or another prepped recipe.</p>'}</section>` : ''}
    <section class="card allergen-card">
      <h2>Allergens</h2>
      <p><strong>Contains:</strong> ${chips(r.allergens, m, 'chip-strong')}</p>
      ${r.may_contain_list.length ? `<p><strong>May contain:</strong> ${chips(r.may_contain_list, m)}</p>` : ''}
      ${r.allergens.length ? `<ul class="plain-list small">${r.allergens.map((a) => `<li><strong>${esc(allergenName(m, a))}</strong> <span class="muted">from ${esc((r.allergen_sources[a] ?? ['added by hand']).join(', '))}</span></li>`).join('')}</ul>` : ''}
      <p class="muted small">Worked out from each ingredient’s allergens. Always check supplier labels when a product changes.</p>
    </section>
    <div class="two-col">
      <section class="card">
        <h2>Ingredients</h2>
        ${r.ingredients.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Ingredient</th><th class="num">Batch</th>${portions !== 1 ? '<th class="num">Per portion</th>' : ''}${costs ? '<th class="num">Cost</th>' : ''}</tr></thead>
          <tbody>${r.ingredients.map((i) => `<tr>
            <td>${ingName(i)}${i.notes ? ` <small class="muted">${esc(i.notes)}</small>` : ''}</td>
            <td class="num">${qty(i.quantity)} ${esc(i.recipe_unit)}</td>
            ${portions !== 1 ? `<td class="num">${qty(perPortion(i.quantity))} ${esc(i.recipe_unit)}</td>` : ''}
            ${costs ? `<td class="num">${money(i.line_cost)}</td>` : ''}</tr>`).join('')}</tbody>
          ${costs ? `<tfoot><tr><th colspan="${portions !== 1 ? 3 : 2}">Batch cost</th><td class="num">${money(r.batch_cost)}</td></tr></tfoot>` : ''}
        </table></div>` : '<p class="muted">No ingredients added.</p>'}
      </section>
      <section class="card">
        <h2>Method</h2>
        ${r.method ? `<div class="method">${esc(r.method)}</div>` : '<p class="muted">No method written yet.</p>'}
        ${r.shelf_life ? `<p><strong>Shelf life / storage:</strong> ${esc(r.shelf_life)}</p>` : ''}
        ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}
        ${costs && !prep ? `<p class="small muted">Square: ${r.square_catalog_object_id || r.square_item_name ? `linked${r.square_item_name ? ` to “${esc(r.square_item_name)}”` : ''}` : 'not linked – sales won’t count towards menu performance'}${r.sku ? ` · SKU ${esc(r.sku)}` : ''}</p>` : ''}
      </section>
    </div>`;
}

// --- Editor (admin) ---

export const renderPrepEdit = (ctx) => renderEdit(ctx, 'prep');

// A Square item's name, with its size when it has one that isn't the default ("Latte (Large)").
const squareName = (i) => `${i.name}${i.variation_name && i.variation_name !== 'Regular' ? ` (${i.variation_name})` : ''}`;

export async function renderEdit(ctx, newKind = 'sold') {
  const { el, params, stale } = ctx;
  const editing = params[0] ? Number(params[0]) : null;
  const [recipe, products, m, squareItems, all] = await Promise.all([
    editing ? api(`/recipes/${editing}`) : null,
    api('/products'),
    meta(),
    api('/recipes/square-items'),
    api('/recipes'),
  ]);
  if (stale()) return;
  const r = recipe ?? { kind: newKind, portions: 1, vat_rated: 1, active: 1, ingredients: [], allergens: [], may_contain_list: [] };
  const prep = r.kind === 'prep';
  const extra = r.extra_allergens ? r.extra_allergens.split(',') : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const categories = [...new Set(all.filter((x) => x.kind === r.kind).map((x) => x.category).filter(Boolean))];
  // Prepped recipes that can go into this one: not itself, and not any that already have this one inside them.
  const recipeById = new Map(all.map((x) => [x.id, x]));
  const contains = (id, target, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (recipeById.get(id)?.ingredients ?? []).some((i) => i.sub_recipe_id === target || (i.sub_recipe_id && contains(i.sub_recipe_id, target, seen)));
  };
  const preps = all.filter((x) => x.kind === 'prep' && x.id !== editing && !(editing && contains(x.id, editing)));

  const currentSquare = r.square_catalog_object_id ? `id:${r.square_catalog_object_id}` : r.square_item_name ? `name:${r.square_item_name}` : '';
  const optionsFor = (items) => items.map((i) => {
    const value = i.catalog_object_id ? `id:${i.catalog_object_id}` : `name:${i.name}`;
    const taken = i.recipe && i.recipe.id !== editing ? ` – linked to ${i.recipe.name}` : '';
    const bits = [i.price !== null && i.price !== undefined ? money(i.price) : '', i.sku ? `SKU ${i.sku}` : '', i.quantity ? `${qty(i.quantity)} sold in 90 days` : 'none sold in 90 days'].filter(Boolean);
    return [value, `${squareName(i)} · ${bits.join(' · ')}${taken}`];
  });
  const squareOptions = optionsFor(squareItems);
  const keyOf = (i) => (i.catalog_object_id ? `id:${i.catalog_object_id}` : `name:${i.name}`);
  let squareByValue = new Map(squareItems.map((i) => [keyOf(i), i]));
  if (currentSquare && !squareOptions.some(([v]) => v === currentSquare)) squareOptions.unshift([currentSquare, r.square_item_name ?? r.square_catalog_object_id]);

  // An ingredient is a product ("p:12") or a prepped recipe ("r:5"), picked by typing part of its name, supplier or
  // category. Prepped recipes are listed first; each product shows its supplier.
  const choices = [
    ...preps.map((x) => ({ value: `r:${x.id}`, name: x.name, meta: `Prepped recipe · measured in ${x.yield_unit}`, prep: true, active: x.active })),
    ...products.map((p) => ({ value: `p:${p.id}`, name: p.name, meta: [p.supplier_name ?? 'No supplier', p.category].filter(Boolean).join(' · '), active: p.active })),
  ].map((c) => ({ ...c, search: `${c.name} ${c.meta}`.toLowerCase() }));
  const choiceByValue = new Map(choices.map((c) => [c.value, c]));
  const canEditProducts = ctx.state.can('setup.products');
  const productMeta = (p) => [p.supplier_name ?? 'No supplier', p.category].filter(Boolean).join(' · ');
  const lineValue = (i) => (i.sub_recipe_id ? `r:${i.sub_recipe_id}` : i.product_id ? `p:${i.product_id}` : '');
  const row = (i = {}) => `
    <tr class="ing-row">
      <td><div class="ing-pick">
        <input class="ing-search" type="search" autocomplete="off" placeholder="Search ingredients or suppliers…" aria-label="Ingredient" value="${esc(choiceByValue.get(lineValue(i))?.name ?? '')}">
        <input type="hidden" class="ing-product" value="${lineValue(i)}">
        <small class="ing-picked muted">${esc(choiceByValue.get(lineValue(i))?.meta ?? '')}</small>
        ${canEditProducts ? `<button type="button" class="link-btn ing-edit" ${lineValue(i).startsWith('p:') ? '' : 'hidden'} title="Edit this product without leaving the recipe">✎ Edit product</button>` : ''}
        <ul class="ing-options" role="listbox" hidden></ul>
      </div></td>
      <td class="num"><input class="ing-qty qty-input" type="number" min="0" step="any" value="${i.quantity ?? ''}" aria-label="Quantity"> <span class="ing-unit muted">${esc(i.recipe_unit ?? '')}</span></td>
      <td><input class="ing-notes" value="${esc(i.notes ?? '')}" placeholder="e.g. grated" aria-label="Notes"></td>
      <td class="num ing-cost"></td>
      <td><button type="button" class="icon-btn ing-remove" aria-label="Remove ingredient">×</button></td>
    </tr>`;
  const allergenBoxes = (name, selected) => `<div class="allergen-grid">${m.allergens.map(([k, label]) => `
    <label class="check"><input type="checkbox" name="${name}" value="${k}" ${selected.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>`;

  el.innerHTML = `
    <div class="page-head">
      <h1>${editing ? `Edit ${esc(r.name)}` : prep ? 'New prepped recipe' : 'New sold item'}</h1>
      <div class="actions"><a class="btn" href="#/${base(r)}${editing ? `/${editing}` : ''}">Cancel</a></div>
    </div>
    <form id="recipe-form">
      <div class="kpis sticky-kpis">
        <div class="kpi"><span>Batch cost</span><strong id="k-batch">–</strong></div>
        <div class="kpi"><span id="k-portion-label">${prep ? `Cost per ${esc(r.yield_unit ?? 'unit')}` : 'Cost per portion'}</span><strong id="k-portion">–</strong></div>
        ${prep ? '' : '<div class="kpi" id="k-gp-box"><span>GP after VAT</span><strong id="k-gp">–</strong></div>'}
        <div class="kpi"><span>Allergens (from ingredients)</span><strong id="k-allergens" class="small">–</strong></div>
      </div>
      ${prep ? '' : `<section class="card recipe-square">
        <h2>Square</h2>
        ${field('Square menu item', `<select name="square" id="recipe-square"><option value="">Not linked</option>${squareOptions.map(([v, l]) => `<option value="${esc(v)}" ${v === currentSquare ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
          { hint: squareItems.length ? 'Pick the item from Square to fill in its name, SKU, selling price and category. Linking also counts its Square sales towards menu performance and ingredient usage.' : 'Import Square sales first (Setup → Square) to choose an item' })}
        <button type="button" class="link-btn" id="square-refresh" title="Read the item list from Square again – for items, SKUs or prices just changed in Square">↻ Refresh from Square</button>
      </section>`}
      <section class="card">
        <div class="row">${field('Name', input('name', r.name, `required id="recipe-name" placeholder="${prep ? 'e.g. Tomato sauce' : 'e.g. Ham & cheese toastie'}"`))}${prep ? '' : field('SKU', input('sku', r.sku || squareByValue.get(currentSquare)?.sku, 'id="recipe-sku" maxlength="100" placeholder="From Square"'))}${field('Category', input('category', r.category, `list="recipe-cats" id="recipe-category" placeholder="${prep ? 'e.g. Sauces' : 'e.g. Hot food'}"`))}</div>
        <datalist id="recipe-cats">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        ${prep ? `<div class="row">
          ${field('Each batch makes', input('yield_quantity', r.yield_quantity, 'type="number" min="0.0001" step="any" required id="recipe-yield" placeholder="e.g. 2000"'), { hint: 'Weigh or measure what one batch actually makes, after cooking' })}
          ${field('Yield unit', input('yield_unit', r.yield_unit, 'required maxlength="30" list="yield-units" id="recipe-yield-unit" placeholder="e.g. g"'), { hint: 'Recipes using this measure it in the same unit' })}
        </div>
        <datalist id="yield-units">${['g', 'kg', 'ml', 'L', 'portions', 'each', 'slices'].map((u) => `<option value="${u}">`).join('')}</datalist>` : `<div class="row">
          ${field('Selling price (£)', input('selling_price', r.selling_price, 'type="number" min="0" step="0.01" id="recipe-price"'))}
          ${field('Portions this recipe makes', input('portions', r.portions, 'type="number" min="0.01" step="any" id="recipe-portions"'))}
          ${field('VAT', `<select name="vat_rated" id="recipe-vat"><option value="1" ${r.vat_rated ? 'selected' : ''}>Standard rated (20%)</option><option value="0" ${r.vat_rated ? '' : 'selected'}>Zero-rated</option></select>`, { hint: 'Hot food and drinks are standard rated; most cold takeaway food is zero-rated' })}
        </div>`}
      </section>
      <section class="card">
        <h2>Ingredients</h2>
        <p class="muted small">Quantities are for the whole recipe, in each product’s recipe unit (set on the product, e.g. 4L milk = 4000 ml). Prepped recipes are measured in their yield unit${preps.length ? '' : ' – add some under Menu → Prepped recipes to use them here'}.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">Quantity</th><th>Notes</th><th class="num">Cost</th><th></th></tr></thead>
          <tbody id="ing-body">${(r.ingredients.length ? r.ingredients : [{}]).map(row).join('')}</tbody>
        </table></div>
        <button type="button" class="btn btn-small" id="add-ing">+ Add ingredient</button>
      </section>
      <section class="card">
        <h2>Method and storage</h2>
        ${field('Method', textarea('method', r.method, 'rows="8" id="recipe-method" placeholder="Step by step, including cooking temperatures"'))}
        ${field('Shelf life / storage', input('shelf_life', r.shelf_life, 'id="recipe-shelf" placeholder="e.g. Use by end of next day, keep below 5°C"'))}
        ${field(prep ? 'Notes' : 'Menu description', textarea('description', r.description, 'rows="2" id="recipe-desc"'))}
      </section>
      <section class="card">
        <h2>Allergens</h2>
        <p class="muted small">Allergens from the ingredients are added automatically. Tick any others the recipe contains (e.g. from a garnish you don’t stock as a product).</p>
        <h3 class="group-title">Also contains</h3>${allergenBoxes('extra_allergens', extra)}
        <h3 class="group-title">May contain (cross-contamination warning)</h3>${allergenBoxes('may_contain', r.may_contain_list)}
      </section>
      ${prep ? `<section class="card">
        <label class="check-row"><input type="checkbox" name="in_stock_takes" ${r.in_stock_takes === 0 ? '' : 'checked'}>
          <span><strong>Count in stock takes</strong><small>Adds it to each site’s stock take, counted in ${esc(r.yield_unit ?? 'its yield unit')} and valued at its cost per unit.</small></span></label>
        ${field('Active', `<input type="checkbox" name="active" ${r.active ? 'checked' : ''}>`, { className: 'field-inline' })}</section>` : `<section class="card">
        ${field('Active', `<input type="checkbox" name="active" ${r.active ? 'checked' : ''}>`, { className: 'field-inline' })}
      </section>`}
      <p class="form-error" hidden></p>
      <div class="actions"><button class="btn btn-primary" type="submit">Save ${prep ? 'prepped recipe' : 'recipe'}</button></div>
    </form>`;

  const form = el.querySelector('#recipe-form');
  const body = el.querySelector('#ing-body');
  // Refresh: read Square's item list again (new items, SKUs, prices), keeping what's picked and typed.
  form.querySelector('#square-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      await api('/recipes/square-items/refresh', { method: 'POST' });
      const items = await api('/recipes/square-items');
      squareByValue = new Map(items.map((i) => [keyOf(i), i]));
      const select = form.querySelector('#recipe-square');
      const picked = select.value;
      const opts = optionsFor(items);
      if (picked && !opts.some(([v]) => v === picked)) opts.unshift([picked, r.square_item_name ?? picked]);
      select.innerHTML = `<option value="">Not linked</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === picked ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
      const i = squareByValue.get(picked);
      if (i?.sku && !form.sku.value) form.sku.value = i.sku;
      toast(`Square items refreshed${i ? (i.sku ? ` – SKU ${i.sku}` : ' – this item has no SKU in Square') : ''}`);
    } catch (err) { showError(err); }
    btn.disabled = false;
    btn.textContent = '↻ Refresh from Square';
  });
  // Picking a Square item fills in its name, SKU, selling price and category from Square.
  form.querySelector('#recipe-square')?.addEventListener('change', (e) => {
    const i = squareByValue.get(e.target.value);
    if (!i) return;
    const filled = [];
    const set = (name, value, label) => { if (value === null || value === undefined || value === '') return; form[name].value = value; filled.push(label); };
    set('name', squareName(i), 'name');
    set('sku', i.sku, 'SKU');
    set('selling_price', i.price, 'selling price');
    set('category', i.category, 'category');
    form.selling_price.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`Filled in the ${filled.join(', ').replace(/, ([^,]*)$/, ' and $1')} from Square`);
  });
  const update = () => {
    let batch = 0;
    const allergens = new Set();
    body.querySelectorAll('.ing-row').forEach((tr) => {
      const [type, rawId] = tr.querySelector('.ing-product').value.split(':');
      const q = Number(tr.querySelector('.ing-qty').value) || 0;
      if (type === 'r') {
        const sub = recipeById.get(Number(rawId));
        const cost = q * (sub?.cost_per_unit ?? 0);
        batch += cost;
        tr.querySelector('.ing-unit').textContent = sub?.yield_unit ?? '';
        tr.querySelector('.ing-cost').textContent = money(cost);
        for (const a of sub?.allergens ?? []) allergens.add(a);
        return;
      }
      const p = byId.get(Number(rawId));
      tr.querySelector('.ing-unit').textContent = p ? (p.recipe_unit || p.unit) : '';
      const cost = p ? q * (p.unit_cost / (p.units_per_pack || 1)) : 0;
      batch += cost;
      tr.querySelector('.ing-cost').textContent = p ? money(cost) : '';
      for (const a of (p?.allergens ?? '').split(',').filter(Boolean)) allergens.add(a);
    });
    el.querySelector('#k-batch').textContent = money(batch);
    if (prep) {
      const made = Number(form.yield_quantity.value) || 0;
      el.querySelector('#k-portion-label').textContent = `Cost per ${form.yield_unit.value || 'unit'}`;
      el.querySelector('#k-portion').textContent = made ? unitPrice(batch / made) : '–';
    } else {
      const portions = Number(form.portions.value) || 1;
      const perPortion = batch / portions;
      const price = Number(form.selling_price.value) || 0;
      const net = form.vat_rated.value === '1' ? price / 1.2 : price;
      const gp = net > 0 ? ((net - perPortion) / net) * 100 : null;
      el.querySelector('#k-portion').textContent = money(perPortion);
      el.querySelector('#k-gp').textContent = gp === null ? '–' : `${gp.toFixed(1)}% · ${money(net - perPortion)}`;
      el.querySelector('#k-gp-box').className = `kpi kpi-${gpTone(gp, m.target_gp)}`;
    }
    el.querySelector('#k-allergens').textContent = [...allergens].map((a) => allergenName(m, a)).join(', ') || 'None';
  };
  // The search box: matches every word typed against the name, supplier and category.
  const bindPicker = (tr) => {
    const search = tr.querySelector('.ing-search');
    const hidden = tr.querySelector('.ing-product');
    const picked = tr.querySelector('.ing-picked');
    // The list lives on the page itself, so no card or scrolling table around the row can move or cut it off.
    const list = tr.querySelector('.ing-options');
    list.classList.add('ing-options-page');
    document.body.append(list);
    tr.addEventListener('ing:removed', () => list.remove());
    let shown = [];
    let at = -1;
    const editBtn = tr.querySelector('.ing-edit');
    const choose = (c) => {
      hidden.value = c?.value ?? '';
      search.value = c?.name ?? '';
      picked.textContent = c?.meta ?? '';
      if (editBtn) editBtn.hidden = !hidden.value.startsWith('p:');
      list.hidden = true;
      update();
    };
    // ✎ Edit product: change the product (cost, pack, recipe unit, allergens…) in a pop-up, then carry on with the
    // recipe – its cost, unit and allergens here update straight away.
    editBtn?.addEventListener('click', async () => {
      const productId = Number(hidden.value.slice(2));
      const product = byId.get(productId);
      if (!product) return;
      try {
        await openProductEditor(product, async () => {
          const fresh = (await api('/products')).find((x) => x.id === productId);
          if (!fresh) return;
          Object.assign(product, fresh);
          const c = choiceByValue.get(`p:${productId}`);
          Object.assign(c, { name: fresh.name, meta: productMeta(fresh), active: fresh.active });
          c.search = `${c.name} ${c.meta}`.toLowerCase();
          // Every row using this product shows its new name and details.
          body.querySelectorAll('.ing-row').forEach((row) => {
            if (row.querySelector('.ing-product').value !== `p:${productId}`) return;
            row.querySelector('.ing-search').value = c.name;
            row.querySelector('.ing-picked').textContent = c.meta;
          });
          update();
        });
      } catch (err) { showError(err); }
    });
    // On focus everything is listed; typing narrows it down.
    const draw = (all = false) => {
      const words = all ? [] : search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = choices.filter((c) => (c.active || c.value === hidden.value) && words.every((w) => c.search.includes(w))).slice(0, 60);
      at = shown.length ? 0 : -1;
      list.innerHTML = shown.length ? shown.map((c, n) => `<li role="option" data-n="${n}" class="${n === at ? 'is-at' : ''}">
          <strong>${esc(c.name)}</strong>${c.prep ? ' <span class="badge badge-sent">Prepped</span>' : ''}<small>${esc(c.meta)}</small></li>`).join('')
        : '<li class="ing-none">No ingredient matches – add it under Stock & Ordering → Products</li>';
      // Fixed to the screen, so the table's scrolling box doesn't cut it off.
      const box = search.getBoundingClientRect();
      const below = window.innerHeight - box.bottom;
      Object.assign(list.style, { left: `${box.left}px`, width: `${Math.min(Math.max(box.width, 300), window.innerWidth - box.left - 8)}px`, maxHeight: `${Math.max(160, Math.min(320, below > 200 ? below - 12 : box.top - 12))}px` });
      if (below > 200) { list.style.top = `${box.bottom + 2}px`; list.style.bottom = ''; } else { list.style.bottom = `${window.innerHeight - box.top + 2}px`; list.style.top = ''; }
      list.hidden = false;
    };
    const move = (d) => {
      if (!shown.length) return;
      at = (at + d + shown.length) % shown.length;
      list.querySelectorAll('li[data-n]').forEach((li) => li.classList.toggle('is-at', Number(li.dataset.n) === at));
      list.querySelector('.is-at')?.scrollIntoView({ block: 'nearest' });
    };
    search.addEventListener('focus', () => { search.select(); draw(true); });
    search.addEventListener('input', () => draw());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) draw(); else move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { if (!list.hidden && shown[at]) { e.preventDefault(); choose(shown[at]); tr.querySelector('.ing-qty').focus(); } }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    // Mousedown, so picking happens before the box loses focus.
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-n]');
      if (!li) return;
      e.preventDefault();
      choose(shown[Number(li.dataset.n)]);
      tr.querySelector('.ing-qty').focus();
    });
    search.addEventListener('blur', () => {
      list.hidden = true;
      // Typed text that wasn't picked goes back to what was chosen (or clears it, if the box was emptied).
      if (!search.value.trim()) choose(null);
      else search.value = choiceByValue.get(hidden.value)?.name ?? '';
    });
  };
  // Scrolling the page closes an open list (it's fixed to the screen); scrolling the list itself doesn't.
  const closeLists = (e) => {
    if (!el.isConnected) { window.removeEventListener('scroll', closeLists, true); document.querySelectorAll('.ing-options-page').forEach((l) => l.remove()); return; }
    if (!e.target.closest?.('.ing-options')) document.querySelectorAll('.ing-options-page').forEach((l) => { l.hidden = true; });
  };
  window.addEventListener('scroll', closeLists, { passive: true, capture: true });
  // Leaving the page takes its lists with it.
  document.querySelectorAll('.ing-options-page').forEach((l) => l.remove());
  window.addEventListener('hashchange', () => document.querySelectorAll('.ing-options-page').forEach((l) => l.remove()), { once: true });
  const bindRow = (tr) => {
    bindPicker(tr);
    tr.querySelector('.ing-qty').addEventListener('input', update);
    tr.querySelector('.ing-remove').addEventListener('click', () => { tr.dispatchEvent(new Event('ing:removed')); tr.remove(); update(); });
  };
  body.querySelectorAll('.ing-row').forEach(bindRow);
  el.querySelector('#add-ing').addEventListener('click', () => {
    body.insertAdjacentHTML('beforeend', row());
    bindRow(body.lastElementChild);
    body.lastElementChild.querySelector('.ing-search').focus();
  });
  if (prep) ['yield_quantity', 'yield_unit'].forEach((n) => form[n].addEventListener('input', update));
  else {
    ['portions', 'selling_price'].forEach((n) => form[n].addEventListener('input', update));
    form.vat_rated.addEventListener('change', update);
  }
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    err.hidden = true;
    const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((c) => c.value);
    const square = prep ? '' : form.square.value;
    const payload = {
      kind: r.kind,
      yield_quantity: prep ? form.yield_quantity.value : null,
      yield_unit: prep ? form.yield_unit.value : null,
      in_stock_takes: prep ? form.in_stock_takes.checked : false,
      name: form.name.value,
      category: form.category.value || null,
      selling_price: prep ? 0 : form.selling_price.value || 0,
      portions: prep ? 1 : form.portions.value || 1,
      vat_rated: prep ? true : form.vat_rated.value === '1',
      method: form.method.value || null,
      shelf_life: form.shelf_life.value || null,
      description: form.description.value || null,
      extra_allergens: checked('extra_allergens'),
      may_contain: checked('may_contain'),
      square_catalog_object_id: square.startsWith('id:') ? square.slice(3) : null,
      sku: prep ? null : form.sku.value || null,
      square_item_name: square.startsWith('name:') ? square.slice(5) : square ? squareItems.find((i) => `id:${i.catalog_object_id}` === square)?.name ?? r.square_item_name ?? null : null,
      active: form.active.checked,
      ingredients: [...body.querySelectorAll('.ing-row')]
        .map((tr) => {
          const [type, rawId] = tr.querySelector('.ing-product').value.split(':');
          return { product_id: type === 'p' ? rawId : null, sub_recipe_id: type === 'r' ? rawId : null, quantity: tr.querySelector('.ing-qty').value, notes: tr.querySelector('.ing-notes').value || null };
        })
        .filter((i) => i.product_id || i.sub_recipe_id),
    };
    if (payload.ingredients.some((i) => i.quantity === '')) {
      err.textContent = 'Enter a quantity for every ingredient';
      err.hidden = false;
      return;
    }
    try {
      const saved = await api(editing ? `/recipes/${editing}` : '/recipes', { method: editing ? 'PUT' : 'POST', body: payload });
      toast(prep ? 'Prepped recipe saved' : 'Recipe saved');
      ctx.navigate(`${base(r)}/${saved.id}`);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

// --- Allergen matrix ---

export async function renderAllergens(ctx) {
  const { el, stale } = ctx;
  const [recipes, m] = await Promise.all([api('/recipes'), meta()]);
  if (stale()) return;
  const active = recipes.filter((r) => r.active && r.kind === 'sold');

  el.innerHTML = `
    <div class="page-head"><h1>Allergen matrix</h1></div>
    <div class="filters">
      <label for="free-from">Show dishes free from</label>
      <select id="free-from"><option value="">— everything —</option>${m.allergens.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
    </div>
    <section class="card">
      <div class="table-wrap"><table class="matrix">
        <thead><tr><th>Dish</th>${m.allergens.map(([k, l]) => `<th class="rot" title="${esc(l)}"><span>${esc(shortName(m, k))}</span></th>`).join('')}</tr></thead>
        <tbody>${active.map((r) => `<tr data-allergens="${r.allergens.join(',')}">
          <th><a href="#/recipes/${r.id}">${esc(r.name)}</a></th>
          ${m.allergens.map(([k, l]) => (r.allergens.includes(k)
            ? `<td class="has" title="${esc(r.name)} contains ${esc(l)}">●</td>`
            : r.may_contain_list.includes(k) ? `<td class="may" title="May contain ${esc(l)}">○</td>` : '<td></td>')).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">● contains · ○ may contain. Built from recipe ingredients; update products when a supplier changes a recipe. Customers with severe allergies should always be told about cross-contamination risk.</p>
    </section>`;

  el.querySelector('#free-from').addEventListener('change', (e) => {
    const k = e.target.value;
    el.querySelectorAll('tr[data-allergens]').forEach((tr) => { tr.hidden = !!k && tr.dataset.allergens.split(',').includes(k); });
  });
}

// --- Menu performance (managers) ---

export async function renderPerformance(ctx) {
  const { el, state, query, stale } = ctx;
  const to = query.to || todayISO();
  const from = query.from || addDays(to, -6);
  const scope = siteScope(state, query.scope);
  const [data, m] = await Promise.all([
    api(`/recipes/performance${qs({ from, to, location_id: scope === 'all' ? undefined : state.locationId })}`),
    meta(),
  ]);
  if (stale()) return;
  const t = data.totals;

  el.innerHTML = `
    <div class="page-head"><h1>Menu performance</h1></div>
    <form class="filters" id="range">
      ${siteFilter(state, scope)}
      <input type="date" name="from" value="${from}"> <span>to</span> <input type="date" name="to" value="${to}" max="${todayISO()}">
      <button class="btn" type="submit">Update</button>
    </form>
    <div class="kpis">
      <div class="kpi"><span>Sales of costed items (ex VAT)</span><strong>${money(t.net_sales)}</strong></div>
      <div class="kpi"><span>Theoretical food & packaging cost</span><strong>${money(t.food_cost)}</strong></div>
      <div class="kpi kpi-${gpTone(t.gp_pct, m.target_gp)}"><span>GP · ${money(t.gp)}</span><strong>${fmtPct(t.gp_pct)}</strong></div>
    </div>
    <section class="card">
      <h2>By menu item · ${fmtDate(from)} – ${fmtDate(to)}</h2>
      ${data.items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Net sales</th><th class="num">Cost each</th><th class="num">Food cost</th><th class="num">GP</th><th class="num">GP %</th></tr></thead>
        <tbody>${data.items.map((i) => `<tr>
          <td><a href="#/recipes/${i.recipe_id}">${esc(i.name)}</a></td><td class="num">${qty(i.quantity)}</td><td class="num">${money(i.net_sales)}</td>
          <td class="num">${money(i.cost_per_portion)}</td><td class="num">${money(i.food_cost)}</td><td class="num">${money(i.gp)}</td>
          <td class="num"><span class="tone-${gpTone(i.gp_pct, m.target_gp)}">${fmtPct(i.gp_pct)}</span></td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No sales of recipe-linked items in this period. Link recipes to Square items to see them here.</p>'}
      <p class="muted small">Uses today’s ingredient prices. Actual GP will be lower by wastage and over-portioning.</p>
    </section>
    <div class="two-col">
      <section class="card">
        <h2>Ingredients these sales should have used</h2>
        ${data.usage.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">Used</th><th class="num">Packs</th><th class="num">Cost</th></tr></thead>
          <tbody>${data.usage.map((u) => `<tr><td>${esc(u.name)}</td><td class="num">${qty(u.used)} ${esc(u.recipe_unit)}</td>
            <td class="num">${qty(u.packs)} ${esc(u.unit)}</td><td class="num">${money(u.cost)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing yet.</p>'}
      </section>
      <section class="card">
        <h2>Square items without a recipe</h2>
        ${data.unlinked.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Net sales</th></tr></thead>
          <tbody>${data.unlinked.map((u) => `<tr><td>${esc(u.name)}${u.variation_name && u.variation_name !== 'Regular' ? ` <small class="muted">${esc(u.variation_name)}</small>` : ''}</td>
            <td class="num">${qty(u.quantity)}</td><td class="num">${money(u.net_sales)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${state.can('recipes.edit') ? '<p class="small"><a href="#/recipes/new">Add a sold item</a> and link it to the Square item to include it.</p>' : ''}` : '<p class="muted">Every item sold has a recipe.</p>'}
      </section>
    </div>`;

  el.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    ctx.navigate(`recipes/performance${qs({ from: f.from.value, to: f.to.value, scope: f.scope?.value })}`);
  });
}

