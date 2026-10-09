/**
 * #818 — what the app tells PostHog about sign-up, kept as plain functions so the rules
 * are testable without a browser, an OAuth round trip or a PostHog project.
 *
 * Two facts the funnel needs and the app did not emit:
 *  1. WHERE a visitor came from, held across the sign-up flow (first touch wins) and
 *     stamped on `user_signed_up` as `first_touch_*`. No cookie and no cross-site id:
 *     sessionStorage, which survives the Google redirect away and back in the same tab.
 *  2. Whether a Google authentication was a NEW account (a sign-up) or a returning one
 *     (a login), learned from the redirect the OAuth callback lands on, not guessed
 *     from a button click.
 */
export const FIRST_TOUCH_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'ref'] as const;
export type FirstTouchKey = (typeof FIRST_TOUCH_KEYS)[number];
export type FirstTouch = Partial<Record<FirstTouchKey, string>>;

const STORAGE_KEY = 'so_first_touch';
const MAX_VALUE_LENGTH = 200;

/** Params off a query string. Absent or blank means ABSENT: never an empty string (AC3). */
export function parseFirstTouch(search: string): FirstTouch {
  const params = new URLSearchParams(search);
  const out: FirstTouch = {};
  for (const key of FIRST_TOUCH_KEYS) {
    const value = params.get(key)?.trim().slice(0, MAX_VALUE_LENGTH);
    if (value) out[key] = value;
  }
  return out;
}

/** `first_touch_utm_source` etc., present only for the params that exist. */
export function firstTouchProperties(touch: FirstTouch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FIRST_TOUCH_KEYS) {
    const value = touch[key];
    if (value) out[`first_touch_${key}`] = value;
  }
  return out;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The first touch in this tab, or {} — a corrupt value reads as none rather than throwing. */
export function readFirstTouch(store: Store): FirstTouch {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: FirstTouch = {};
    for (const key of FIRST_TOUCH_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, MAX_VALUE_LENGTH);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Remember the landing URL's params. FIRST touch wins: once something is stored, a later
 * page carrying different params does not overwrite it, and a page with none does nothing.
 */
export function captureFirstTouch(search: string, store: Store): void {
  try {
    if (Object.keys(readFirstTouch(store)).length > 0) return;
    const touch = parseFirstTouch(search);
    if (Object.keys(touch).length > 0) store.setItem(STORAGE_KEY, JSON.stringify(touch));
  } catch {
    // storage can be unavailable (private mode, blocked): an unattributed sign-up is a gap, not a failure
  }
}

/** Where Google sends the browser back to. `newUserCallbackURL` is better-auth's own signal that the account was just created. */
export const GOOGLE_RETURNING_CALLBACK = '/?auth_event=logged_in&method=google';
export const GOOGLE_NEW_USER_CALLBACK = '/?auth_event=signed_up&method=google';

export type AuthEvent = { event: 'user_signed_up' | 'user_logged_in'; method: 'google' };

/** Reads the marker off the landing URL. Anything outside the two known values is ignored. */
export function authEventFromSearch(search: string): AuthEvent | null {
  const params = new URLSearchParams(search);
  if (params.get('method') !== 'google') return null;
  const event = params.get('auth_event');
  if (event === 'signed_up') return { event: 'user_signed_up', method: 'google' };
  if (event === 'logged_in') return { event: 'user_logged_in', method: 'google' };
  return null;
}

/** The same URL without the marker, so a reload or a copied link does not fire the event again. */
export function stripAuthEvent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('auth_event');
  params.delete('method');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Which surface sent an event. Applied in PostHog's `before_send`, i.e. to EVERY event at the moment
 * it is sent, rather than registered once as a super property. A registered property does not
 * survive `posthog.reset()`, which `IdentitySync` calls on every identity change (login, logout,
 * another tab) — so after the first login in a tab, later events lost `surface` (ticket #818, found
 * by verification). `$pageview`, `$identify` and the first pageview captured inside `init` were
 * missing it for the same reason. There is nothing to re-register after a reset, because nothing
 * was registered.
 */
export function withSurface<E extends { properties?: Record<string, unknown> } | null>(event: E): E {
  if (!event) return event;
  return { ...event, properties: { surface: 'app', ...(event.properties ?? {}) } } as E;
}
