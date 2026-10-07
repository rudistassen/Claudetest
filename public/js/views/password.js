import { api, esc } from '../lib.js';
import { logo } from '../logo.js';

// The page an invite or "forgot password" email links to: choose a password, then you're signed in.
export async function renderSetPassword(root, token, onDone) {
  root.innerHTML = '<div class="login-wrap"><div class="card login"><div class="loading">Checking your link…</div></div></div>';
  let link;
  try {
    link = await api(`/auth/token?token=${encodeURIComponent(token ?? '')}`);
  } catch (err) {
    root.innerHTML = `<div class="login-wrap"><div class="card login">
      <h1 class="login-logo" aria-label="Atlas">${logo(40)}</h1>
      <p><strong>${esc(err.message)}</strong></p>
      <p class="muted">Invite links work for 14 days and password reset links for 2 hours, and each only works once.
        Ask your manager to send a new invite, or use “Forgot password?” on the sign-in page.</p>
      <button type="button" class="btn btn-primary btn-block" id="to-sign-in">Go to sign in</button></div></div>`;
    root.querySelector('#to-sign-in').addEventListener('click', () => { location.href = `${location.pathname}${location.search}`; });
    return;
  }
  const invite = link.purpose === 'invite';
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login card" novalidate>
        <h1 class="login-logo" aria-label="Atlas">${logo(40)}</h1>
        <h2 class="set-pw-title">${invite ? `Welcome, ${esc(link.name.split(' ')[0])}!` : 'Choose a new password'}</h2>
        <p class="muted">${invite ? 'Choose a password for Atlas. You’ll sign in with' : 'For'} <strong>${esc(link.email)}</strong>.</p>
        <input type="email" name="username" value="${esc(link.email)}" autocomplete="username" hidden>
        <label class="field"><span>New password</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="field"><span>Type it again</span><input name="again" type="password" autocomplete="new-password" required></label>
        <p class="muted small">At least 8 characters.</p>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">${invite ? 'Join Atlas' : 'Save password and sign in'}</button>
      </form>
    </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  form.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (form.password.value.length < 8) return fail('Your password needs at least 8 characters.');
    if (form.password.value !== form.again.value) return fail('The two passwords don’t match.');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { user } = await api('/auth/token', { method: 'POST', body: { token, password: form.password.value } });
      await onDone(user, invite);
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false;
    }
  });
}

// "Forgot password?" on the sign-in page.
export function openForgot(root, email, back) {
  root.querySelector('.login').outerHTML = `<form class="login card forgot" novalidate>
    <h1 class="login-logo" aria-label="Atlas">${logo(40)}</h1>
    <h2 class="set-pw-title">Forgot your password?</h2>
    <p class="muted">Enter the email you sign in with and we’ll email you a link to choose a new one.</p>
    <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required value="${esc(email)}"></label>
    <p class="form-error" hidden></p>
    <button class="btn btn-primary btn-block" type="submit">Email me a link</button>
    <button class="btn btn-ghost btn-block" type="button" data-back>Back to sign in</button>
  </form>`;
  const form = root.querySelector('.forgot');
  form.email.focus();
  form.querySelector('[data-back]').addEventListener('click', () => back());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    if (!form.reportValidity()) return;
    form.querySelector('button').disabled = true;
    try {
      const r = await api('/auth/forgot', { method: 'POST', body: { email: form.email.value.trim() } });
      form.innerHTML = `<h1 class="login-logo" aria-label="Atlas">${logo(40)}</h1>
        <h2 class="set-pw-title">Check your email</h2>
        ${r.email_ready
          ? `<p>If <strong>${esc(form.email.value.trim())}</strong> has a Atlas account, we’ve sent it a link to choose a new password. It works for 2 hours.</p>
             <p class="muted small">Nothing arrived after a few minutes? Check your junk folder, or ask your manager to set a new password for you.</p>`
          : '<p>Atlas can’t send emails yet, so ask your manager to set a new password for you (Setup → Staff).</p>'}
        <button class="btn btn-block" type="button" data-back>Back to sign in</button>`;
      form.querySelector('[data-back]').addEventListener('click', () => back());
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.querySelector('button').disabled = false;
    }
  });
}
