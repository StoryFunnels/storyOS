// StoryOS service worker — MN-230a (PWA foundation).
//
// Scope: offline app-shell caching + a push-notification scaffold. There is
// no build-time precache manifest (that needs a webpack/workbox plugin this
// ticket doesn't add) — instead it caches same-origin GET responses as
// they're fetched, so a page visited once is available offline afterward.
//
// #288: bumped so any browser that already has an old worker registered
// (from before local dev stopped registering one at all — see
// lib/service-worker.ts) picks up this version, wipes its old cache on
// `activate`, and starts running the `/_next/static/*` bypass below. That
// self-heals a stale dev registration without anyone touching devtools.
const CACHE_VERSION = 'storyos-shell-v2';

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

  // #288: Turbopack's dev-mode chunk URLs under `/_next/static/*` aren't
  // immutable the way a production build's are — the same URL can serve
  // different content across a dev-server restart or after an edit. A
  // cache-first policy here previously meant a service worker registered
  // once in dev could serve a pre-edit JS bundle forever. `lib/
  // service-worker.ts` now skips registering in dev entirely, but this
  // worker doesn't know its own environment (it's a static public asset,
  // not run through Next's env replacement) — so this bypass also protects
  // anyone still running an already-registered worker from a session
  // before that guard shipped. `networkFirst` still falls back to the
  // cache when offline, so production's offline app shell is unaffected.
  if (url.pathname.startsWith('/_next/static/')) {
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
