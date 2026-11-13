/* AROM TRADE service worker
   - Pages: network first, cached copy when offline (the app opens without a connection)
   - Static files (icons, manifest, fonts): stale-while-revalidate
   - /api/*, Supabase, Telegram and other live data: never cached, always from the network */
const VERSION = 'arom-v2';
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

/* ---------- Web Push: show alerts in the phone / iPad / desktop notification bar ---------- */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'AROM TRADE', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'AROM TRADE';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: d.url || '/' }, vibrate: [120, 60, 120], timestamp: Date.now(),
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if (new URL(w.url).origin === self.location.origin) { await w.focus(); try { await w.navigate(target); } catch (_) {} return; } }
    await self.clients.openWindow(target);
  })());
});
