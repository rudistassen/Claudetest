import { api, esc } from '../lib.js';

export function render(root, onLogin) {
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login card">
        <h1>Cafe Ops</h1>
        <p class="muted">Sign in to manage your site.</p>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
    </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  form.email.focus();
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
