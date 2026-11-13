/* AROM TRADE service worker
   - Pages: network first, cached copy when offline (the app opens without a connection)
   - Static files (icons, manifest, fonts): stale-while-revalidate
   - /api/*, Supabase, Telegram and other live data: never cached, always from the network */
const VERSION = 'arom-v1';
const SHELL = ['/', '/analysis', '/pricing', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !fonts) return;      // Supabase, Yahoo, Telegram… go straight to the network
  if (url.pathname.startsWith('/api/')) return;                     // live prices, candles, news: never cached

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(VERSION); c.put(url.pathname === '/index.html' ? '/' : url.pathname, res.clone());
        return res;
      } catch (_) {
        const c = await caches.open(VERSION);
        return (await c.match(url.pathname)) || (await c.match('/')) || new Response('<h1>Offline</h1><p>AROM TRADE needs a connection for live data. Reconnect and try again.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(VERSION), hit = await c.match(req);
    const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })());
});
