/**
 * MN-230a — PWA foundation. Registers the offline app-shell service worker
 * in production only; push subscription is a scaffold that stays inert
 * until a VAPID key is configured (wiring push sends to Inbox/approvals is
 * later work, MN-216 territory).
 *
 * #288: this used to register unconditionally, including under `next dev`.
 * Turbopack's dev chunks aren't content-hashed the way production output
 * is, so a service worker's cache-first fetch handler could silently keep
 * serving a pre-edit JS bundle forever — surviving a dev-server restart and
 * even a `.next` deletion, with nothing pointing at the SW as the cause.
 * `public/sw.js` also bypasses caching for `/_next/static/*` as
 * defense-in-depth. Outside production we don't just skip registering a
 * new worker — we actively unregister any existing one and clear its
 * caches, so a session that already carries a stale dev registration from
 * before this guard existed self-heals on next load, with no manual
 * devtools trip required.
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  if (process.env.NODE_ENV !== 'production') {
    void unregisterStaleServiceWorkers();
    return;
  }

  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  // This runs from a React effect, well after hydration — the window 'load'
  // event has almost always already fired by then, so listening for it here
  // would silently never register. Register immediately if the page is
  // already loaded; only wait for the event if it's genuinely still pending.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

/**
 * Best-effort cleanup for non-production environments: unregisters any
 * service worker left over from a session that predates the
 * production-only guard above, and clears whatever it cached. Failures are
 * swallowed — there's nothing actionable to do about them, and this must
 * never throw from a React effect.
 */
async function unregisterStaleServiceWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // Best-effort — nothing more to do if cleanup itself fails.
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Scaffold only — returns null and does nothing until
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY is set. Posting the subscription to the
 * backend isn't wired yet; there's no endpoint to send it to.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey || typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });
}
