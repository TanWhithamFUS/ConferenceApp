// Service worker: offline access to pages you've opened, plus push notifications.
const VERSION = 'v1';
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const PRECACHE = ['/css/app.css', '/js/app.js', '/icons/icon.svg', '/icons/icon-192.png', '/'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/manage') || url.pathname.startsWith('/api/') || url.pathname === '/login') return;

  // Static assets: cache first, refresh in the background.
  if (/^\/(css|js|icons)\//.test(url.pathname)) {
    event.respondWith(caches.open(STATIC).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    }));
    return;
  }

  // Pages: network first so updates show immediately; fall back to the last copy when offline.
  if (request.mode === 'navigate' || url.pathname.startsWith('/e/') || url.pathname === '/') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(PAGES).then((c) => c.put(request, copy)); }
          return res;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error()),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Steubenville Conferences', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Steubenville Conferences', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) return client.navigate(target);
        return;
      }
    }
    return self.clients.openWindow(target);
  })());
});
