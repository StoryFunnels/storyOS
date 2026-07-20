// StoryOS service worker — MN-230a (PWA foundation).
//
// Scope: offline app-shell caching + a push-notification scaffold. There is
// no build-time precache manifest (that needs a webpack/workbox plugin this
// ticket doesn't add) — instead it caches same-origin GET responses as
// they're fetched, so a page visited once is available offline afterward.
const CACHE_VERSION = 'storyos-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls always go to the network — caching them would serve stale
  // workspace data, which is worse than a clear network error.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone());
  }
  return response;
}

// --- Push scaffold (MN-230a) --------------------------------------------
// Wiring a real subscription to the backend, and sending pushes from the
// Inbox/approvals flow, is deferred (MN-216 territory) — this just makes
// the runtime side correct in advance so that work is additive later.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'StoryOS', body: event.data.text() };
  }
  const { title = 'StoryOS', body, url = '/' } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientsList.find((c) => c.url === targetUrl);
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
