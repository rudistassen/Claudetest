import { isDemo, openModal, toast } from './lib.js';

// Installing Atlas as an app (a Progressive Web App): registers the service worker and offers an
// "Install app" button where the browser allows it, or step-by-step instructions on iPhone/iPad.

let deferred = null;

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 'installed' | 'prompt' (the browser can install it) | 'ios' | 'manual' | 'unavailable' (the demo, or not https). */
export function installState() {
  if (standalone()) return 'installed';
  if (isDemo || !('serviceWorker' in navigator) || !window.isSecureContext) return 'unavailable';
  if (deferred) return 'prompt';
  return isIos() ? 'ios' : 'manual';
}

// Keeping Atlas up to date. An app left open in the background (on a phone especially) keeps showing the
// version it first loaded, so it checks for a newer one whenever it's brought back to the screen, and every
// ten minutes. Coming back to it, it simply reloads (unless a form is open); otherwise a bar offers the update.
async function serverVersion() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null;
  }
}

function offerUpdate() {
  if (document.getElementById('update-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'update-bar';
  bar.className = 'update-bar';
  bar.innerHTML = '<span>A new version of Atlas is ready.</span><button type="button" class="btn btn-small btn-primary">Update now</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.append(bar);
}

async function watchForUpdates() {
  const loaded = await serverVersion();
  if (!loaded) return;
  let checking = false;
  const check = async (resumed) => {
    if (checking) return;
    checking = true;
    const latest = await serverVersion();
    checking = false;
    if (!latest || latest === loaded) return;
    const busy = document.getElementById('modal-root')?.childElementCount || document.activeElement?.matches('input, textarea, select');
    if (resumed && !busy) location.reload();
    else offerUpdate();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(true); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(true); });
  setInterval(() => check(false), 10 * 60 * 1000);
}

// A phone set to "Desktop site" ignores Atlas's phone layout and draws it as a shrunk-down computer screen.
// Spot that (a small touch screen showing a page much wider than itself) and explain how to switch it off.
const DESKTOP_HINT_KEY = 'cafe-ops:desktop-hint-dismissed';
export function desktopModeOnPhone() {
  const small = Math.min(screen.width, screen.height);
  return navigator.maxTouchPoints > 0 && small < 600 && window.innerWidth > small * 1.35;
}

function desktopModeSteps() {
  const samsung = /SamsungBrowser/i.test(navigator.userAgent);
  const inApp = standalone();
  const chrome = `<ol>
      ${inApp ? '<li>Open <strong>Chrome</strong> (the browser, not the Atlas app).</li>' : ''}
      <li>Tap the <strong>⋮</strong> menu (three dots, top right).</li>
      <li>Tap <strong>Settings</strong>, then <strong>Site settings</strong>, then <strong>Desktop site</strong>.</li>
      <li>Turn <strong>Desktop site</strong> off.</li>
      <li>Close Atlas fully (swipe it away from your open apps) and open it again.</li>
    </ol>`;
  const samsungSteps = `<ol>
      ${inApp ? '<li>Open <strong>Samsung Internet</strong> (the browser, not the Atlas app).</li>' : ''}
      <li>Tap the <strong>☰</strong> menu (bottom right).</li>
      <li>If you see <strong>Mobile version</strong>, tap it. Otherwise open <strong>Settings</strong> and make sure <strong>Desktop version</strong> is off (look under <strong>Browsing</strong> or <strong>Useful features</strong>).</li>
      <li>Close Atlas fully (swipe it away from your open apps) and open it again.</li>
    </ol>`;
  return `<p>Your phone is set to show websites as they look on a computer, so Atlas appears tiny and you have to zoom in. Switching this off gives you the phone layout.</p>
    ${samsung ? `<h3>Samsung Internet</h3>${samsungSteps}<h3>If you use Chrome</h3>${chrome}` : `<h3>Chrome</h3>${chrome}<h3>If you use Samsung Internet</h3>${samsungSteps}`}
    <p class="muted small">On an iPhone: in Safari tap <strong>aA</strong> in the address bar and choose <strong>Request Mobile Website</strong>.</p>`;
}

export function checkDesktopMode() {
  if (!desktopModeOnPhone() || document.getElementById('desktop-hint')) return;
  // Pop-up forms are drawn larger so they can be read without zooming.
  document.body.classList.add('desktop-mode');
  try { if (sessionStorage.getItem(DESKTOP_HINT_KEY)) return; } catch { /* storage unavailable */ }
  const bar = document.createElement('div');
  bar.id = 'desktop-hint';
  bar.className = 'desktop-hint';
  bar.innerHTML = `<p><strong>Atlas looks tiny?</strong> Your phone is showing the computer version.</p>
    <div><button type="button" class="btn btn-primary" data-how>Show me how to fix it</button>
    <button type="button" class="btn" data-dismiss>Not now</button></div>`;
  bar.querySelector('[data-how]').addEventListener('click', () => openModal({ title: 'Get the phone layout', body: desktopModeSteps() }));
  bar.querySelector('[data-dismiss]').addEventListener('click', () => {
    bar.remove();
    try { sessionStorage.setItem(DESKTOP_HINT_KEY, '1'); } catch { /* storage unavailable */ }
  });
  document.body.append(bar);
}

const refresh = () => {
  const s = installState();
  document.querySelectorAll('[data-install]').forEach((el) => { el.hidden = !(s === 'prompt' || s === 'ios'); });
  window.dispatchEvent(new Event('install:changed'));
};

export function setUpInstall() {
  checkDesktopMode();
  if (isDemo || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  // A tapped notification, when the phone can't open its page directly: go there.
  navigator.serviceWorker.addEventListener?.('message', (e) => {
    if (e.data?.type !== 'open' || !e.data.url) return;
    const to = new URL(e.data.url, location.href);
    if (to.origin === location.origin && to.hash) {
      // Same page, different screen: switch to it (re-showing it if it's already the one open).
      if (location.hash === to.hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
      else location.hash = to.hash;
    } else location.href = to.href;
  });
  watchForUpdates();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    toast('Atlas is installed – look for it on your home screen or in your apps');
    refresh();
  });
}

function iosSteps() {
  return `<ol class="install-steps">
    <li>Make sure this page is open in <strong>Safari</strong>.</li>
    <li>Tap the <strong>Share</strong> button <svg class="ios-share" width="16" height="18" viewBox="0 0 16 20" aria-hidden="true"><path d="M8 1v12M4 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8H2.5A1.5 1.5 0 0 0 1 9.5v8A1.5 1.5 0 0 0 2.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 13.5 8H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> (the square with an arrow, at the bottom or top of the screen).</li>
    <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
    <li>Tap <strong>Add</strong>. Atlas appears on your home screen like any other app.</li>
  </ol>`;
}

export async function install() {
  const s = installState();
  if (s === 'prompt') {
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') deferred = null;
    refresh();
  } else if (s === 'ios') {
    openModal({ title: 'Install Atlas on your iPhone or iPad', body: iosSteps() });
  } else {
    openModal({ title: 'Install Atlas', body: manualSteps() });
  }
}

function manualSteps() {
  return `<ul class="install-steps">
    <li><strong>Chrome or Edge on a computer:</strong> click the install icon at the right-hand end of the address bar (a screen with a down arrow), or open the ⋮ menu → <strong>Cast, save and share → Install page as app</strong> (Edge: ⋯ → <strong>Apps → Install this site as an app</strong>).</li>
    <li><strong>Android (Chrome):</strong> open the ⋮ menu → <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
    <li><strong>iPhone or iPad:</strong> in Safari, tap <strong>Share → Add to Home Screen</strong>.</li>
    <li><strong>Firefox</strong> doesn’t install apps on computers – use Chrome or Edge.</li>
  </ul>`;
}

/** A card for the Account page. */
export function installCard() {
  const s = installState();
  if (s === 'unavailable') return '';
  if (s === 'installed') return '<section class="card narrow install-card"><h2>Atlas app</h2><p class="muted">✓ You’re using the installed app.</p></section>';
  return `<section class="card narrow install-card">
    <h2>Get the Atlas app</h2>
    <p>Install Atlas on this ${isIos() || /android/i.test(navigator.userAgent) ? 'phone or tablet' : 'computer'} so it opens from an icon, full screen, like any other app. It stays up to date by itself.</p>
    ${s === 'ios' ? iosSteps() : s === 'prompt' ? '<button class="btn btn-primary" id="install-now">Install Atlas</button>' : manualSteps()}
  </section>`;
}

export function wireInstallCard(root) {
  root.querySelector('#install-now')?.addEventListener('click', install);
}

refresh();
