// Brewly's service worker: makes the app installable and quick to open. Everything is fetched fresh from the
// server first, so updates show straight away; the saved copy is only used when there's no connection.
// Data (/api) is never saved here.
const CACHE = 'brewly-v6';
const SHELL = ['/', '/css/styles.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/img/brewly.svg', '/fonts/fraunces-latin.woff2', '/fonts/manrope-latin.woff2'];

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
        return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brewly</title><body style="font-family:sans-serif;padding:2rem;color:#1f5f4a"><h1>Brewly</h1><p>You’re offline. Check your connection and try again.</p></body>', { headers: { 'Content-Type': 'text/html' } });
      }
      throw new Error('offline');
    }
  })());
});
