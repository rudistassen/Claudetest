(() => {
  const cfg = window.HUNT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'halloween-hunt:' + cfg.name;

  // ----- Saved progress (per phone) -----------------------------------------

  let storageOk = true;
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && typeof saved === 'object' && saved.found) return saved;
    } catch {
      storageOk = false;
    }
    return { found: {} };
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      storageOk = false;
    }
  }
  const state = load();

  // Only count codes that are still in the config (in case one was replaced).
  const byCode = new Map(cfg.checkpoints.map((c) => [c.code, c]));
  const foundCount = () => Object.keys(state.found).filter((code) => byCode.has(code)).length;
  const hasWon = () => foundCount() >= cfg.required;

  // ----- Dates --------------------------------------------------------------

  function todayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function prettyDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function huntStatus() {
    const today = todayIso();
    if (cfg.startDate && today < cfg.startDate) return 'early';
    if (cfg.endDate && today > cfg.endDate) return 'over';
    return 'open';
  }

  // ----- Scanning -----------------------------------------------------------

  function handleScan() {
    const params = new URLSearchParams(location.search);
    const code = params.get('c');
    if (code === null) return;
    // Drop the code from the address bar so a refresh doesn't re-scan it.
    history.replaceState(null, '', location.pathname + location.hash);

    const status = huntStatus();
    if (status === 'early') {
      return showModal('🕯️', 'Not yet!', `The hunt starts on ${prettyDate(cfg.startDate)}. Come back then!`, 'OK');
    }
    if (status === 'over') {
      return showModal('🪦', 'The hunt is over', 'Thanks for playing! Keep an eye out for our next hunt.', 'OK');
    }

    const cp = byCode.get(code.trim());
    if (!cp) {
      return showModal('❓', 'Hmm, that\'s not right', 'That QR code isn\'t part of the hunt. Try scanning it again.', 'OK');
    }
    if (state.found[cp.code]) {
      return showModal('👻', 'Already found', `You've already collected ${cp.name}. Find a different one!`, 'Keep hunting');
    }

    const wasWon = hasWon();
    state.found[cp.code] = new Date().toISOString();
    if (!wasWon && hasWon()) {
      state.prizeCode = makePrizeCode();
      state.wonAt = new Date().toISOString();
    }
    save();

    const left = cfg.required - foundCount();
    if (!wasWon && hasWon()) {
      showModal('🏆', 'You did it!', `${cp.found} That's all ${cfg.required} — you've won ${cfg.prize}!`, 'See my prize');
    } else if (left > 0) {
      showModal('🎃', cp.name, `${cp.found} Only ${left} more to go!`, 'Keep hunting');
    } else {
      showModal('🎃', cp.name, cp.found, 'Nice!');
    }
  }

  function makePrizeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    return 'BOO-' + Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  // ----- Rendering ----------------------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderHeader() {
    document.title = cfg.name;
    $('title').textContent = cfg.name;
    $('business').textContent = cfg.business || '';
    $('intro').textContent = cfg.intro;
  }

  function renderNotice() {
    const notice = $('notice');
    const status = huntStatus();
    let text = '';
    if (status === 'early') text = `The hunt opens on ${prettyDate(cfg.startDate)}. Have a look at the clues now!`;
    else if (status === 'over' && !hasWon()) text = 'The hunt has finished. Thanks for playing!';
    if (!storageOk) text += ' Your browser is blocking saved progress (private browsing?), so scans may be lost.';
    notice.hidden = !text.trim();
    notice.textContent = text.trim();
  }

  function renderProgress() {
    const n = foundCount();
    const box = $('pumpkins');
    box.replaceChildren();
    for (let i = 0; i < cfg.required; i++) {
      box.append(el('span', i < n ? 'pumpkin lit' : 'pumpkin', '🎃'));
    }
    const shown = Math.min(n, cfg.required);
    $('count').textContent = hasWon()
      ? `All ${cfg.required} found!`
      : `${shown} of ${cfg.required} found`;
  }

  function renderClues() {
    const list = $('clues');
    list.replaceChildren();
    cfg.checkpoints.forEach((cp, i) => {
      const done = Boolean(state.found[cp.code]);
      const li = el('li', done ? 'clue done' : 'clue');
      const head = el('div', 'clue-head');
      head.append(el('span', 'clue-num', done ? '✓' : String(i + 1)));
      head.append(el('span', 'clue-name', done ? cp.name : 'Mystery location'));
      li.append(head);
      li.append(el('p', 'clue-text', cp.clue));
      list.append(li);
    });
  }

  let clockTimer = null;
  function renderPrize() {
    const box = $('prize');
    clearInterval(clockTimer);
    if (!hasWon()) {
      box.hidden = true;
      return;
    }
    if (!state.prizeCode) {
      state.prizeCode = makePrizeCode();
      save();
    }
    box.hidden = false;
    box.replaceChildren();
    box.classList.toggle('claimed', Boolean(state.redeemedAt));

    if (state.redeemedAt) {
      box.append(el('div', 'prize-icon', '✅'));
      box.append(el('h2', null, 'Prize claimed'));
      box.append(el('p', null, `Claimed on ${new Date(state.redeemedAt).toLocaleString()}. Thanks for playing — Happy Halloween!`));
      box.append(el('p', 'prize-code', state.prizeCode));
      return;
    }

    box.append(el('div', 'prize-icon spin', '🏆'));
    box.append(el('h2', null, 'You found them all!'));
    box.append(el('p', 'prize-what', `You've won ${cfg.prize}`));
    box.append(el('p', 'prize-code', state.prizeCode));
    // A live clock shows staff this is the real page, not a screenshot.
    const clock = el('p', 'prize-clock');
    const tick = () => (clock.textContent = new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    tick();
    clockTimer = setInterval(tick, 1000);
    box.append(clock);
    box.append(el('p', 'prize-how', cfg.claimInstructions));

    const btn = el('button', 'btn btn-ghost', 'Staff: mark as claimed');
    btn.type = 'button';
    btn.addEventListener('click', redeem);
    box.append(btn);
  }

  function redeem() {
    const pin = prompt('Staff only: enter the staff PIN to mark this prize as claimed.');
    if (pin === null) return;
    if (pin.trim() !== String(cfg.staffPin)) {
      alert('That PIN is not right.');
      return;
    }
    state.redeemedAt = new Date().toISOString();
    save();
    render();
  }

  function render() {
    renderNotice();
    renderPrize();
    renderProgress();
    renderClues();
  }

  // ----- Modal --------------------------------------------------------------

  function showModal(icon, title, text, button) {
    $('modal-icon').textContent = icon;
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal-close').textContent = button;
    $('modal').hidden = false;
    $('modal-close').focus();
  }
  $('modal-close').addEventListener('click', () => {
    $('modal').hidden = true;
    if (hasWon()) $('prize').scrollIntoView({ behavior: 'smooth' });
  });

  renderHeader();
  handleScan();
  render();
})();
