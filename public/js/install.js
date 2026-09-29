import { isDemo, openModal, toast } from './lib.js';

// Installing BrewView as an app (a Progressive Web App): registers the service worker and offers an
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

// Keeping BrewView up to date. An app left open in the background (on a phone especially) keeps showing the
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
  bar.innerHTML = '<span>A new version of BrewView is ready.</span><button type="button" class="btn btn-small btn-primary">Update now</button>';
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

const refresh = () => {
  const s = installState();
  document.querySelectorAll('[data-install]').forEach((el) => { el.hidden = !(s === 'prompt' || s === 'ios'); });
  window.dispatchEvent(new Event('install:changed'));
};

export function setUpInstall() {
  if (isDemo || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  watchForUpdates();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    toast('BrewView is installed – look for it on your home screen or in your apps');
    refresh();
  });
}

function iosSteps() {
  return `<ol class="install-steps">
    <li>Make sure this page is open in <strong>Safari</strong>.</li>
    <li>Tap the <strong>Share</strong> button <svg class="ios-share" width="16" height="18" viewBox="0 0 16 20" aria-hidden="true"><path d="M8 1v12M4 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8H2.5A1.5 1.5 0 0 0 1 9.5v8A1.5 1.5 0 0 0 2.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 13.5 8H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> (the square with an arrow, at the bottom or top of the screen).</li>
    <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
    <li>Tap <strong>Add</strong>. BrewView appears on your home screen like any other app.</li>
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
    openModal({ title: 'Install BrewView on your iPhone or iPad', body: iosSteps() });
  } else {
    openModal({ title: 'Install BrewView', body: manualSteps() });
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
  if (s === 'installed') return '<section class="card narrow install-card"><h2>BrewView app</h2><p class="muted">✓ You’re using the installed app.</p></section>';
  return `<section class="card narrow install-card">
    <h2>Get the BrewView app</h2>
    <p>Install BrewView on this ${isIos() || /android/i.test(navigator.userAgent) ? 'phone or tablet' : 'computer'} so it opens from an icon, full screen, like any other app. It stays up to date by itself.</p>
    ${s === 'ios' ? iosSteps() : s === 'prompt' ? '<button class="btn btn-primary" id="install-now">Install BrewView</button>' : manualSteps()}
  </section>`;
}

export function wireInstallCard(root) {
  root.querySelector('#install-now')?.addEventListener('click', install);
}

refresh();
