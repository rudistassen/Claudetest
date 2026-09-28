import { api, esc, isDemo } from '../lib.js';
import { logo } from '../logo.js';

const DEMO_ACCOUNTS = [
  ['admin@cafe.local', 'Owner', 'All 7 sites, sales, setup'],
  ['manager2@cafe.local', 'Site manager', 'Market Square: rota, orders, stock'],
  ['staff1@cafe.local', 'Barista', 'High Street: checks, wastage, counts'],
];

export function render(root, onLogin) {
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login card">
        <h1 class="login-logo" aria-label="BrewView">${logo(40)}</h1>
        <p class="muted">Sign in to manage your site.</p>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        ${isDemo ? `
        <div class="demo-accounts">
          <p><strong>Demo</strong> – sign in as:</p>
          ${DEMO_ACCOUNTS.map(([email, role, what]) => `<button type="button" class="btn demo-account" data-email="${email}"><strong>${role}</strong><small>${what}</small></button>`).join('')}
          <p class="muted small">Everything runs in this page with made-up data and a pretend Square account. Changes reset when you reload.</p>
        </div>` : ''}
      </form>
    </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  form.email.focus();
  form.querySelectorAll('.demo-account').forEach((b) => b.addEventListener('click', () => {
    form.email.value = b.dataset.email;
    form.password.value = 'changeme123';
    form.requestSubmit();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      await onLogin(user);
    } catch (ex) {
      err.innerHTML = esc(ex.message);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}
