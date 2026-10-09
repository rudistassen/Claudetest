// Atlas's service worker: makes the app installable and quick to open. Everything is fetched fresh from the
// server first, so updates show straight away; the saved copy is only used when there's no connection.
// Data (/api) is never saved here.
const CACHE = 'atlas-v73';
const SHELL = ['/', '/css/styles.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/img/atlas.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const saved = await caches.match(req.mode === 'navigate' ? '/' : req);
      if (saved) return saved;
      if (req.mode === 'navigate') {
        return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas</title><body style="font-family:sans-serif;padding:2rem;color:#1f5f4a"><h1>Atlas</h1><p>You’re offline. Check your connection and try again.</p></body>', { headers: { 'Content-Type': 'text/html' } });
      }
      throw new Error('offline');
    }
  })());
});

// Phone notifications from Atlas: show them, and open the page they're about when tapped.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Atlas', body: e.data?.text() ?? '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Atlas', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => new URL(c.url).origin === self.location.origin);
    // Atlas already open (often in the background, on whatever page it was left on): bring it up and tell it which
    // page to show. (Navigating it from here doesn't work reliably on phones – it can just come back on the old page.)
    if (here) {
      await here.focus().catch(() => {});
      here.postMessage({ type: 'open', url });
      return;
    }
    return self.clients.openWindow(url);
  })());
});
