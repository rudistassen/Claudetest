import { api, esc, showError, toast } from './lib.js';

// My Atlas → Phone notifications: turn them on for this phone, choose which kinds, send a test. On an iPhone they
// only work once Atlas is added to the Home Screen and opened from there (an Apple rule).

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// The key from the server, in the form the phone wants.
function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function thisPhone() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Fills in the notifications card (an element with id="mb-push"). isAdmin shows how to set them up. */
export async function renderNotifications(box, { isAdmin = false } = {}) {
  if (!box) return;
  let data;
  try { data = await api('/push'); } catch { box.hidden = true; return; }
  if (!box.isConnected) return;
  if (!data.enabled) {
    if (!isAdmin) { box.hidden = true; return; }
    box.innerHTML = `<h2>🔔 Phone notifications</h2>
      <p class="muted small">Not set up yet. Add <strong>VAPID_PUBLIC_KEY</strong> and <strong>VAPID_PRIVATE_KEY</strong> to the server’s settings (in Railway → Variables), then everyone can turn them on here.</p>`;
    return;
  }
  const sub = await thisPhone().catch(() => null);
  const onHere = !!sub && data.devices.some((d) => d.endpoint === sub.endpoint);
  const blocked = supported() && Notification.permission === 'denied';
  const groups = [...new Set(data.kinds.map((k) => k.group))];

  let status;
  if (!supported() || (isIos() && !standalone())) {
    status = isIos() && !standalone()
      ? '<p class="notice small">On an iPhone, add Atlas to your Home Screen first: in Safari tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. Then open Atlas from its icon and come back here.</p>'
      : '<p class="muted small">This browser can’t show notifications. Try Chrome on Android, or Atlas added to the Home Screen on an iPhone.</p>';
  } else if (blocked) {
    status = '<p class="notice small">Notifications are blocked for Atlas on this phone. Allow them in the phone’s Settings (Notifications → Atlas), then come back here.</p>';
  } else if (onHere) {
    status = `<p class="push-on">✓ On for this phone</p>
      <div class="actions"><button class="btn btn-small" id="push-test">Send a test</button><button class="btn btn-small btn-ghost" id="push-off">Turn off on this phone</button></div>`;
  } else {
    status = '<p class="muted small">Get a notification on this phone when your rota is published, a shift changes, your holiday is approved and more.</p><button class="btn btn-primary" id="push-on">Turn on notifications on this phone</button>';
  }

  box.innerHTML = `<h2>🔔 Phone notifications</h2>${status}
    ${data.devices.length && !onHere ? `<p class="muted small">On ${data.devices.length} other device${data.devices.length === 1 ? '' : 's'}.</p>` : ''}
    <details class="push-kinds" ${onHere ? 'open' : ''}><summary>Choose which notifications you get</summary>
      ${groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${data.kinds.filter((k) => k.group === g).map((k) => `
        <label class="check-row"><input type="checkbox" data-kind="${k.key}" ${k.on ? 'checked' : ''}><span>${esc(k.label)}</span></label>`).join('')}</fieldset>`).join('')}
    </details>`;

  box.querySelector('#push-on')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications weren’t allowed. You can allow them in the phone’s settings.');
      const reg = await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.public_key) });
      await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
      toast('Notifications are on for this phone');
      renderNotifications(box, { isAdmin });
    } catch (err) { showError(err); e.target.disabled = false; }
  });
  box.querySelector('#push-off')?.addEventListener('click', async () => {
    try {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe().catch(() => {});
      toast('Notifications turned off for this phone');
      renderNotifications(box, { isAdmin });
    } catch (err) { showError(err); }
  });
  box.querySelector('#push-test')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/push/test', { method: 'POST' });
      toast(r.sent ? 'Test sent – it should pop up in a few seconds' : 'The test couldn’t be delivered – try turning notifications off and on again', r.sent ? 'ok' : 'error');
    } catch (err) { showError(err); }
    e.target.disabled = false;
  });
  box.querySelectorAll('[data-kind]').forEach((c) => c.addEventListener('change', async () => {
    try { await api('/push/prefs', { method: 'PUT', body: { kinds: { [c.dataset.kind]: c.checked } } }); toast('Saved'); } catch (err) { showError(err); c.checked = !c.checked; }
  }));
}
