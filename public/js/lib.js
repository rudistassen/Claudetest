// Shared helpers: API calls, escaping, formatting, modals and toasts.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

export const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n || 0);
export const qty = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 }));

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

export function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '–';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

// SQLite datetime('now') values are UTC without a zone marker.
export function fmtDateTime(sqlUtc) {
  if (!sqlUtc) return '–';
  return new Date(`${sqlUtc.replace(' ', 'T')}Z`).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });
}

export function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 5000 : 2500);
}

export const showError = (err) => toast(err.message || String(err), 'error');

// Reads a form into a plain object; empty strings become null, checkboxes become booleans.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value === '' ? null : el.value;
  }
  return out;
}

/**
 * Opens a modal containing a form. onSubmit receives the form values; if it resolves the modal closes,
 * if it throws the error is shown and the modal stays open.
 */
export function openModal({ title, body, submitLabel = 'Save', onSubmit, danger, onDanger, wide = false }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal ${wide ? 'modal-wide' : ''}" novalidate>
        <header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
        <div class="modal-body">${body}</div>
        <p class="form-error" hidden></p>
        <footer>
          ${danger ? `<button type="button" class="btn btn-danger" data-danger>${esc(danger)}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="btn" data-close>Cancel</button>
          ${onSubmit ? `<button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>` : ''}
        </footer>
      </form>
    </div>`;
  const form = root.querySelector('form');
  const errEl = root.querySelector('.form-error');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(); });
  const run = async (fn) => {
    errEl.hidden = true;
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await fn();
      close();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    run(() => onSubmit(formData(form), form));
  });
  if (danger) root.querySelector('[data-danger]').addEventListener('click', () => run(onDanger));
  form.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return { form, close };
}

export function confirmDialog(message, { confirmLabel = 'Confirm', title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const { form } = openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      submitLabel: confirmLabel,
      onSubmit: async () => { confirmed = true; resolve(true); },
    });
    const observer = new MutationObserver(() => {
      if (!form.isConnected) {
        observer.disconnect();
        if (!confirmed) resolve(false);
      }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// Small form-field builders to keep view templates short.
export function field(label, input, { hint, className = '' } = {}) {
  return `<label class="field ${className}"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}

export function input(name, value, attrs = '') {
  return `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
}

export function select(name, options, selected, attrs = '') {
  return `<select name="${name}" ${attrs}>${options
    .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`)
    .join('')}</select>`;
}

export function textarea(name, value, attrs = '') {
  return `<textarea name="${name}" rows="3" ${attrs}>${esc(value ?? '')}</textarea>`;
}

export function statusBadge(status) {
  const labels = { draft: 'Draft', sent: 'Sent', received: 'Received', cancelled: 'Cancelled', in_progress: 'In progress', completed: 'Completed', pass: 'Pass', fail: 'Fail' };
  return `<span class="badge badge-${status}">${labels[status] ?? esc(status)}</span>`;
}

export function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}
