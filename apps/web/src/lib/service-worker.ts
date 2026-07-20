/**
 * MN-230a — PWA foundation. Registers the offline app-shell service worker
 * unconditionally; push subscription is a scaffold that stays inert until a
 * VAPID key is configured (wiring push sends to Inbox/approvals is later
 * work, MN-216 territory).
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
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
