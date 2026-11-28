import { safeNextPath } from '@/lib/safe-next';

/**
 * Ticket #1394 — where someone goes after signing in when they were sent a link while signed out.
 *
 * The workspace layout used to send a signed-out visitor to plain `/login`, so the record, document or notification link they
 * opened was lost: sign-in landed them in the workspace, not on what they were sent. The link now travels as `?next=` (which the
 * login and sign-up pages already honour for email) and, for Google, inside the callback URL that the OAuth round trip returns to.
 * Every reader goes through `safeNextPath`, so only a path on this site survives.
 */

/** `/login?next=<where they were>`. The current path is the thing worth returning to, unless it IS the front door. */
export function loginPathFor(current: string): string {
  const next = safeNextPath(current);
  if (next === '/' || next.startsWith('/login') || next.startsWith('/signup')) return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

/** The return path on the URL Google brought the browser back to, or null when there is none worth following. */
export function returnPathFromSearch(search: string): string | null {
  const safe = safeNextPath(new URLSearchParams(search).get('next'));
  return safe === '/' ? null : safe;
}

/** Appends `next` to a Google callback so the round trip returns to the link, not to the workspace picker. */
export function withReturnPath(callback: string, next: string | null | undefined): string {
  const safe = safeNextPath(next);
  if (safe === '/') return callback;
  return `${callback}${callback.includes('?') ? '&' : '?'}next=${encodeURIComponent(safe)}`;
}
