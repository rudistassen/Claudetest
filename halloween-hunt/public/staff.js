(() => {
  const $ = (id) => document.getElementById(id);

  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function showSignedIn(role) {
    $('login').hidden = true;
    $('signed-in').hidden = false;
    $('logout').hidden = false;
    $('admin').hidden = role !== 'admin';
    if (role === 'admin') loadStats();
    $('q').focus();
  }

  function showLogin() {
    $('login').hidden = false;
    $('signed-in').hidden = true;
    $('logout').hidden = true;
    $('password').focus();
  }

  function handleAuthError(err) {
    if (err.status === 401) {
      showLogin();
      return true;
    }
    return false;
  }

  // ----- Prize check --------------------------------------------------------

  function showResult(player, message) {
    const box = $('result');
    box.hidden = false;
    box.replaceChildren();
    const prize = player.prize;
    let cls;
    if (!prize) {
      cls = 'bad';
      box.append(el('p', 'big', '✋ Not won yet'));
      box.append(el('p', null, `Found ${player.found} of ${player.required} checkpoints.`));
    } else if (prize.claimedAt) {
      cls = message ? 'ok' : 'bad';
      box.append(el('p', 'big', message || '⛔ Already claimed'));
      box.append(el('p', null, `Claimed ${when(prize.claimedAt)}.`));
    } else {
      cls = 'warn';
      box.append(el('p', 'big', '🏆 Winner — not claimed yet'));
      const btn = el('button', 'btn', 'Give prize & mark as claimed');
      btn.type = 'button';
      btn.addEventListener('click', () => claim(prize.code, btn));
      box.append(btn);
    }
    box.className = 'result ' + cls;
    box.insertBefore(el('p', null, player.email), box.children[1] || null);
    if (prize) box.insertBefore(el('p', null, `Claim code ${prize.code}`), box.children[2] || null);
  }

  function showError(message) {
    const box = $('result');
    box.hidden = false;
    box.className = 'result bad';
    box.replaceChildren(el('p', 'big', '⚠️ ' + message));
  }

  async function claim(code, btn) {
    btn.disabled = true;
    try {
      const player = await api('staff/claim', { claimCode: code });
      showResult(player, '✅ Claimed — hand over the prize!');
      if (!$('admin').hidden) loadStats();
    } catch (err) {
      if (!handleAuthError(err)) showError(err.message);
    }
  }

  $('lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      showResult(await api('staff/lookup?q=' + encodeURIComponent($('q').value)));
    } catch (err) {
      if (!handleAuthError(err)) showError(err.message);
    }
  });

  // ----- Admin --------------------------------------------------------------

  async function loadStats() {
    let s;
    try {
      s = await api('admin/stats');
    } catch (err) {
      return handleAuthError(err);
    }
    const stat = (n, label) => {
      const d = el('div', 'stat');
      d.append(el('b', null, String(n)), el('span', null, label));
      return d;
    };
    $('stats').replaceChildren(
      stat(s.players, 'players'),
      stat(s.winners, 'winners'),
      stat(s.claimed, 'prizes claimed'),
      stat(s.marketingOptIns, 'marketing opt-ins'),
    );
    $('cp-table').replaceChildren(...s.checkpoints.map((c) => {
      const tr = el('tr');
      tr.append(el('td', null, `${c.number}. ${c.name}`), el('td', null, String(c.scans)));
      return tr;
    }));
  }

  $('delete-emails').addEventListener('click', async () => {
    if (!confirm('Delete the email addresses of everyone who did not opt in to marketing? ' +
      'Do this after the hunt has finished: those people will no longer be able to check or claim a prize. This cannot be undone.')) return;
    try {
      const r = await api('admin/delete-emails', {});
      alert(`Deleted ${r.deleted} email address${r.deleted === 1 ? '' : 'es'}.`);
      loadStats();
    } catch (err) {
      if (!handleAuthError(err)) alert(err.message);
    }
  });

  // ----- Sign in / out ------------------------------------------------------

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').hidden = true;
    try {
      const { role } = await api('staff/login', { password: $('password').value });
      $('password').value = '';
      showSignedIn(role);
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('staff/logout', {});
    $('result').hidden = true;
    $('q').value = '';
    showLogin();
  });

  api('staff/me').then(({ role }) => showSignedIn(role), showLogin);
})();
