import { api, esc, field, input, openModal, select, showError, toast } from '../lib.js';

// Stock & Ordering → Product categories: the categories every product goes in, and the Xero account code each
// one's invoice lines are coded to when a bill is sent to Xero.

export async function render(ctx) {
  const { el, state, stale, rerender } = ctx;
  const canEdit = state.can('setup.products');
  const [cats, xero] = await Promise.all([api('/product-categories'), canEdit ? api('/xero/options').catch(() => null) : null]);
  if (stale()) return;
  const accounts = xero?.accounts ?? [];
  const accountName = (code) => accounts.find((a) => a.code === code)?.name;
  const codeLabel = (code) => (code ? `${esc(code)}${accountName(code) ? ` – ${esc(accountName(code))}` : ''}` : '<span class="muted">Usual account</span>');
  const accountField = (code) => (accounts.length
    ? select('xero_account_code', [['', '— The usual account (Setup → Xero) —'], ...accounts.map((a) => [a.code, `${a.code} – ${a.name}`]),
      ...(code && !accountName(code) ? [[code, `${code} (not found in Xero)`]] : [])], code ?? '')
    : input('xero_account_code', code, 'maxlength="20" placeholder="e.g. 310"'));

  el.innerHTML = `
    <div class="page-head"><h1>Product categories</h1>
      ${canEdit ? '<div class="actions"><button class="btn btn-primary" id="cat-add">+ Category</button></div>' : ''}</div>
    <p class="muted">Every product goes in a category. When an invoice is sent to Xero, each line is coded to its product’s category’s account – or the usual account from Setup → Xero if the category doesn’t have one.</p>
    ${!accounts.length && canEdit ? '<p class="notice small">Connect Xero (Setup → Xero) to pick account codes from a list. Until then you can type the codes in.</p>' : ''}
    <section class="card">
      ${cats.length ? `<div class="table-wrap"><table class="cat-table">
        <thead><tr><th>Category</th><th class="num">Products</th><th>Xero account</th>${canEdit ? '<th></th>' : ''}</tr></thead>
        <tbody>${cats.map((c) => `<tr>
          <td><strong>${esc(c.name)}</strong></td>
          <td class="num"><a href="#/admin/products?q=${encodeURIComponent(c.name)}">${c.product_count}</a></td>
          <td>${canEdit && accounts.length ? `<select data-account="${c.id}" aria-label="Xero account for ${esc(c.name)}">${accountField(c.xero_account_code).replace(/^<select[^>]*>|<\/select>$/g, '')}</select>` : codeLabel(c.xero_account_code)}</td>
          ${canEdit ? `<td class="num"><button class="btn btn-small btn-ghost" data-edit="${c.id}">Edit</button></td>` : ''}
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No categories yet – add one, e.g. Dairy, Coffee, Bakery or Packaging.</div>'}
    </section>`;

  const cat = (cid) => cats.find((c) => c.id === Number(cid));
  const editModal = (c) => openModal({
    title: c ? `Edit ${c.name}` : 'New category',
    body: `${field('Name', input('name', c?.name, 'required maxlength="100" placeholder="e.g. Dairy"'))}
      ${field('Xero account code', accountField(c?.xero_account_code), { hint: 'Invoice lines for products in this category go to this account in Xero' })}
      ${c?.product_count ? `<p class="muted small">Renaming it renames it on its ${c.product_count} product${c.product_count === 1 ? '' : 's'} too.</p>` : ''}`,
    submitLabel: c ? 'Save' : 'Add category',
    onSubmit: async (v) => {
      await api(c ? `/product-categories/${c.id}` : '/product-categories', { method: c ? 'PUT' : 'POST', body: v });
      toast(c ? 'Saved' : 'Category added');
      rerender();
    },
    danger: c ? 'Delete' : null,
    onDanger: async () => {
      if (!c.product_count) {
        await api(`/product-categories/${c.id}`, { method: 'DELETE' });
        toast(`${c.name} deleted`);
        rerender();
        return;
      }
      // Its products need a new home first.
      setTimeout(() => openModal({
        title: `Delete ${c.name}?`,
        body: `<p>${c.product_count} product${c.product_count === 1 ? ' is' : 's are'} in ${esc(c.name)}. Move ${c.product_count === 1 ? 'it' : 'them'} to:</p>
          ${field('Category', select('move_to', cats.filter((x) => x.id !== c.id).map((x) => [x.id, x.name]), ''))}`,
        submitLabel: 'Move and delete',
        onSubmit: async (v) => {
          if (!v.move_to) throw new Error('Add another category to move them to first');
          await api(`/product-categories/${c.id}`, { method: 'DELETE', body: { move_to: Number(v.move_to) } });
          toast(`${c.name} deleted – its products moved`);
          rerender();
        },
      }), 0);
    },
  });

  el.querySelector('#cat-add')?.addEventListener('click', () => editModal(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editModal(cat(b.dataset.edit))));
  el.querySelectorAll('[data-account]').forEach((s) => s.addEventListener('change', async () => {
    try {
      await api(`/product-categories/${s.dataset.account}`, { method: 'PUT', body: { xero_account_code: s.value || null } });
      toast('Xero account saved');
    } catch (err) { showError(err); }
  }));
}
