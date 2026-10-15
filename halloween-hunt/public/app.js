(() => {
  const $ = (id) => document.getElementById(id);
  const PENDING_KEY = 'halloween-hunt:pending-code';
  let hunt = null;

  // ----- Server calls -------------------------------------------------------

  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // A scanned code waits here if the customer hasn't entered their email yet.
  function getPending() {
    try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; }
  }
  function setPending(code) {
    try {
      if (code) sessionStorage.setItem(PENDING_KEY, code);
      else sessionStorage.removeItem(PENDING_KEY);
    } catch { /* private browsing: the customer can rescan */ }
  }

  function prettyDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ----- Scanning -----------------------------------------------------------

  async function submitScan(code) {
    setPending(null);
    let r;
    try {
      r = await api('scan', { code });
    } catch (err) {
      return showModal('⚠️', 'Oops', err.message, 'OK');
    }
    hunt = r.hunt;
    render();
    const p = hunt.player;
    const left = hunt.required - p.found;
    switch (r.result) {
      case 'early':
        return showModal('🕯️', 'Not yet!', `The hunt starts on ${prettyDate(hunt.startDate)}. Come back then!`, 'OK');
      case 'over':
        return showModal('🪦', 'The hunt is over', 'Thanks for playing! Keep an eye out for our next hunt.', 'OK');
      case 'invalid':
        return showModal('❓', 'Hmm, that\'s not right', 'That QR code isn\'t part of the hunt. Try scanning it again.', 'OK');
      case 'already':
        return showModal('👻', 'Already found', `You've already collected ${r.checkpoint.name}. Find a different one!`, 'Keep hunting');
    }
    if (r.won) {
      return showModal('🏆', 'You did it!', `${r.checkpoint.message} That's all ${hunt.required} — you've won ${hunt.prize}!`, 'See my prize');
    }
    if (left > 0) return showModal('🎃', r.checkpoint.name, `${r.checkpoint.message} Only ${left} more to go!`, 'Keep hunting');
    showModal('🎃', r.checkpoint.name, r.checkpoint.message, 'Nice!');
  }

  // ----- Rendering ----------------------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    $('loading').hidden = true;
    document.title = hunt.name;
    $('title').textContent = hunt.name;
    $('business').alt = hunt.business || '';
    $('intro').textContent = hunt.intro;

    const won = Boolean(hunt.player?.prize);
    let notice = '';
    if (hunt.status === 'early') notice = `The hunt opens on ${prettyDate(hunt.startDate)}. Have a look at the clues now!`;
    else if (hunt.status === 'over' && !won) notice = 'The hunt has finished. Thanks for playing!';
    $('notice').hidden = !notice;
    $('notice').textContent = notice;

    $('join').hidden = Boolean(hunt.player);
    $('game').hidden = !hunt.player;
    if (!hunt.player) {
      $('consent-label').textContent = hunt.marketingConsentLabel;
      $('privacy').textContent = hunt.privacyNote;
      $('join-pending').hidden = !getPending();
      return;
    }
    $('who').textContent = hunt.player.email;
    $('scan-btn').hidden = Boolean(hunt.player.prize);
    renderPrize();
    renderProgress();
    renderClues();
  }

  function renderProgress() {
    const n = hunt.player.found;
    const box = $('pumpkins');
    box.replaceChildren();
    for (let i = 0; i < hunt.required; i++) box.append(el('span', i < n ? 'pumpkin lit' : 'pumpkin', '🎃'));
    $('count').textContent = n >= hunt.required ? `All ${hunt.required} found!` : `${n} of ${hunt.required} found`;
  }

  function renderClues() {
    const list = $('clues');
    list.replaceChildren();
    for (const cp of hunt.checkpoints) {
      const li = el('li', cp.found ? 'clue done' : 'clue');
      const head = el('div', 'clue-head');
      head.append(el('span', 'clue-num', cp.found ? '✓' : String(cp.number)));
      head.append(el('span', 'clue-name', cp.found ? cp.name : 'Mystery location'));
      li.append(head, el('p', 'clue-text', cp.clue));
      list.append(li);
    }
  }

  let clockTimer = null;
  let pollTimer = null;
  function renderPrize() {
    const box = $('prize');
    const prize = hunt.player.prize;
    clearInterval(clockTimer);
    clearInterval(pollTimer);
    box.hidden = !prize;
    if (!prize) return;
    box.replaceChildren();
    box.classList.toggle('claimed', Boolean(prize.claimedAt));

    if (prize.claimedAt) {
      box.append(el('div', 'prize-icon', '✅'));
      box.append(el('h2', null, 'Prize claimed'));
      box.append(el('p', null, `Claimed on ${new Date(prize.claimedAt).toLocaleString()}. Thanks for playing — Happy Halloween!`));
      box.append(el('p', 'prize-code', prize.code));
      return;
    }

    box.append(el('div', 'prize-icon spin', '🏆'));
    box.append(el('h2', null, 'You found them all!'));
    box.append(el('p', 'prize-what', `You've won ${hunt.prize}`));
    box.append(el('p', 'prize-label', 'Your claim code'));
    box.append(el('p', 'prize-code', prize.code));
    // A live clock shows staff this is the real page, not a screenshot.
    const clock = el('p', 'prize-clock');
    const tick = () => (clock.textContent = new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    tick();
    clockTimer = setInterval(tick, 1000);
    box.append(clock, el('p', 'prize-how', hunt.claimInstructions));

    // Switch to "claimed" as soon as staff mark it on their device.
    pollTimer = setInterval(async () => {
      try {
        const latest = await api('hunt');
        if (latest.player?.prize?.claimedAt) {
          hunt = latest;
          render();
        }
      } catch { /* try again next time */ }
    }, 10000);
  }

  // ----- In-page QR scanner -------------------------------------------------
  // Uses the browser's built-in QR reader where there is one (Android
  // Chrome), otherwise jsQR, which is only downloaded when first needed.

  const scanner = { stream: null, timer: null, detect: null, lastText: '', msgTimer: null };

  async function qrDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          const detector = new BarcodeDetector({ formats: ['qr_code'] });
          return async (video) => (await detector.detect(video))[0]?.rawValue || null;
        }
      } catch { /* fall back to jsQR */ }
    }
    if (!window.jsQR) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsQR.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('The QR reader could not load. Check your connection.'));
        document.head.append(s);
      });
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
    };
  }

  function scanMessage(text) {
    $('scan-msg').textContent = text;
    clearTimeout(scanner.msgTimer);
    scanner.msgTimer = setTimeout(() => { $('scan-msg').textContent = 'Point your camera at a hunt QR code'; }, 2500);
  }

  function closeScanner() {
    clearTimeout(scanner.timer);
    clearTimeout(scanner.msgTimer);
    scanner.timer = null;
    scanner.stream?.getTracks().forEach((t) => t.stop());
    scanner.stream = null;
    $('scan-video').srcObject = null;
    $('scanner').hidden = true;
    $('scan-msg').textContent = 'Point your camera at a hunt QR code';
  }

  function scanned(text) {
    let code = null;
    try { code = new URL(text, location.href).searchParams.get('c'); } catch { /* not a link */ }
    if (!code) {
      if (text !== scanner.lastText) scanMessage('That isn\'t one of our hunt QR codes. Keep looking!');
      scanner.lastText = text;
      return false;
    }
    closeScanner();
    submitScan(code);
    return true;
  }

  async function openScanner() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return showModal('📷', 'Camera not available', 'Your browser can\'t open the camera here. Use your phone\'s camera app to scan the QR code instead.', 'OK');
    }
    $('scanner').hidden = false;
    scanner.lastText = '';
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const video = $('scan-video');
      video.srcObject = scanner.stream;
      await video.play();
      scanner.detect = scanner.detect || (await qrDecoder());
    } catch (err) {
      closeScanner();
      const blocked = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      return showModal('📷', blocked ? 'Camera blocked' : 'Camera not available',
        blocked
          ? 'Allow camera access for this site in your browser settings and try again, or use your phone\'s camera app to scan the QR code.'
          : 'We couldn\'t open your camera. Use your phone\'s camera app to scan the QR code instead.',
        'OK');
    }
    const loop = async () => {
      if (!scanner.stream) return;
      let text = null;
      try { text = await scanner.detect($('scan-video')); } catch { /* try the next frame */ }
      if (text && scanned(text)) return;
      if (scanner.stream) scanner.timer = setTimeout(loop, 150);
    };
    loop();
  }

  $('scan-btn').addEventListener('click', openScanner);
  $('scan-close').addEventListener('click', closeScanner);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scanner').hidden) closeScanner(); });

  // ----- Join / leave -------------------------------------------------------

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('join-btn');
    $('join-error').hidden = true;
    btn.disabled = true;
    try {
      hunt = await api('join', { email: $('email').value, consent: $('consent').checked });
      render();
      const pending = getPending();
      if (pending) await submitScan(pending);
    } catch (err) {
      $('join-error').textContent = err.message;
      $('join-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('leave').addEventListener('click', async () => {
    if (!confirm('Sign out of the hunt on this phone? You can carry on later by entering the same email.')) return;
    hunt = await api('leave', {});
    $('email').value = '';
    $('consent').checked = false;
    render();
  });

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
    if (hunt?.player?.prize) $('prize').scrollIntoView({ behavior: 'smooth' });
  });

  // ----- Start --------------------------------------------------------------

  async function start() {
    const code = new URLSearchParams(location.search).get('c');
    if (code !== null) {
      // Drop the code from the address bar so a refresh doesn't re-scan it.
      history.replaceState(null, '', location.pathname + location.hash);
      setPending(code);
    }
    try {
      hunt = await api('hunt');
    } catch (err) {
      $('loading').textContent = 'The hunt couldn\'t load. Check your connection and refresh the page.';
      return;
    }
    render();
    const pending = getPending();
    if (pending && hunt.player) await submitScan(pending);
  }
  start();
})();
