import { safeNextPath } from '@/lib/safe-next';

/**
 * Ticket #1302 — how an invite token travels, as plain functions so every hop is testable without a browser, an OAuth round trip or
 * a mail server.
 *
 * The invite link is `/invite?token=…`. The token is the only credential in it, so it is held in exactly two places and nowhere else:
 *
 *  1. The URL the person is sent to next: `?next=` on /signup, /login and /reset, `callbackURL` / `newUserCallbackURL` for Google,
 *     `callbackURL` on the verification email, `redirectTo` on the reset email. This one survives a link opened in another tab or
 *     another device, which is the usual way a verification or reset link is opened.
 *  2. A short-lived sessionStorage entry, the fallback for a hop that dropped the URL (a Google round trip that came back to `/`).
 *
 * It is never logged, never sent to analytics (`scrubTokensFromEvent`) and never drawn on screen.
 *
 * While a token is held, the create-workspace step is unreachable (`newWorkspaceGate`, `postSignInDestination`): an invited person
 * who ends up alone in a workspace of their own is the defect this ticket exists to remove.
 */
export const INVITE_PATH = '/invite';
export const INVITE_STASH_KEY = 'so_invite_token';
/** A held token is forgotten after this long, so a stale one cannot trap someone away from creating a workspace next week. */
export const INVITE_STASH_TTL_MS = 30 * 60 * 1000;

/** `randomBytes(24).toString('base64url')` is 32 characters; the API accepts 16 to 256. Anything else is not a token. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,256}$/;

export function isPlausibleInviteToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/** The Join screen for a token. The ONE place this path is spelled, so a builder cannot drift from the reader below. */
export function inviteJoinPath(token: string): string {
  return `${INVITE_PATH}?token=${encodeURIComponent(token)}`;
}

/** The invite token inside a `?next=` value, or null when `next` is not the Join screen. Goes through `safeNextPath` like every reader of `next`. */
export function inviteTokenFromNext(next: string | null | undefined): string | null {
  const safe = safeNextPath(next);
  if (safe === '/') return null;
  const url = new URL(safe, 'https://storyos.invalid');
  if (url.pathname !== INVITE_PATH) return null;
  const token = url.searchParams.get('token');
  return isPlausibleInviteToken(token) ? token : null;
}

const nextQuery = (token: string) => `next=${encodeURIComponent(inviteJoinPath(token))}`;

/** Sign-up, sign-in and password-reset pages reached FROM an invite carry the Join screen as `next`. */
export const signupHrefForInvite = (token: string) => `/signup?${nextQuery(token)}`;
export const loginHrefForInvite = (token: string) => `/login?${nextQuery(token)}`;
export const resetHrefForInvite = (token: string) => `/reset?${nextQuery(token)}`;

/**
 * Where Google sends the browser back to. Absolute, because better-auth resolves a relative callback against the API's own origin,
 * which is not the web app's when they are served apart. `auth_event` / `method` are the funnel markers `AuthEventBeacon` reads
 * (#818), kept so a Google join is still counted as a sign-up or a login.
 */
export function inviteGoogleCallbacks(origin: string, token: string) {
  const back = `${origin}${inviteJoinPath(token)}`;
  return {
    callbackURL: `${back}&auth_event=logged_in&method=google`,
    newUserCallbackURL: `${back}&auth_event=signed_up&method=google`,
    errorCallbackURL: back,
  };
}

/** The link in the verification email lands here, signed in (`autoSignInAfterVerification`), still holding the token. */
export const inviteVerificationCallback = (origin: string, token: string) => `${origin}${inviteJoinPath(token)}`;

/** The link in the reset email lands on the new-password form, and the form needs to know where to go afterwards. */
export const inviteResetRedirect = (origin: string, token: string) => `${origin}/reset/confirm?${nextQuery(token)}`;

/** After a password reset every session is revoked, so the person signs in again: on the Join screen if they came from an invite. */
export function resetDoneDestination(next: string | null | undefined): string {
  const token = inviteTokenFromNext(next);
  return token ? inviteJoinPath(token) : '/login';
}

// ---- the short-lived fallback ------------------------------------------------------------------------------------------------

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function stashInviteToken(store: Store, token: string, now: number): void {
  if (!isPlausibleInviteToken(token)) return;
  try {
    store.setItem(INVITE_STASH_KEY, JSON.stringify({ t: token, at: now }));
  } catch {
    // storage can be unavailable (private mode): the URL still carries the token
  }
}

/** The token held in this tab, or null when none, expired or unreadable. An expired entry is removed on read. */
export function heldInviteToken(store: Store, now: number): string | null {
  try {
    const raw = store.getItem(INVITE_STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: unknown; at?: unknown };
    if (isPlausibleInviteToken(parsed.t) && typeof parsed.at === 'number' && now - parsed.at >= 0 && now - parsed.at < INVITE_STASH_TTL_MS) {
      return parsed.t;
    }
    store.removeItem(INVITE_STASH_KEY);
    return null;
  } catch {
    return null;
  }
}

export function clearHeldInviteToken(store: Store): void {
  try {
    store.removeItem(INVITE_STASH_KEY);
  } catch {
    // nothing to clear
  }
}

/** The token a page should act on: the URL's own, then the one in `next`, then the held one. */
export function resolveInviteToken(input: { queryToken: string | null; next: string | null; store: Store; now: number }): string | null {
  if (isPlausibleInviteToken(input.queryToken)) return input.queryToken;
  return inviteTokenFromNext(input.next) ?? heldInviteToken(input.store, input.now);
}

// ---- the guard ---------------------------------------------------------------------------------------------------------------

/**
 * Where the app entry route sends a signed-in person. A held invite wins over everything, "no workspace yet" included: that case
 * is exactly where a new invited account used to be sent to /new-workspace.
 */
export function postSignInDestination(input: { workspaceIds: readonly string[]; held: string | null }): string {
  if (input.held) return inviteJoinPath(input.held);
  const first = input.workspaceIds[0];
  return first ? `/w/${first}` : '/new-workspace';
}

/** Whether the create-workspace screen may render. With a held invite it may not: the person is sent to the Join screen instead. */
export function newWorkspaceGate(held: string | null): { allow: true } | { allow: false; redirectTo: string } {
  return held ? { allow: false, redirectTo: inviteJoinPath(held) } : { allow: true };
}

// ---- keeping the token out of analytics --------------------------------------------------------------------------------------

const REDACTED = 'redacted';

/** Redacts the value of every `token` query parameter, and any `token` inside a `next` value (which holds a whole path), in one URL-ish string. */
export function scrubTokensInUrl(value: string): string {
  return value.replace(/([?&])(token|next)=([^&#]*)/gi, (_m, sep: string, key: string, v: string) =>
    key.toLowerCase() === 'token' ? `${sep}token=${REDACTED}` : `${sep}next=${encodeURIComponent(scrubTokensInUrl(safeDecode(v)))}`,
  );
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** PostHog `before_send`: every string property that is a URL carrying a token has it redacted (`$current_url`, `$referrer`, …). */
export function scrubTokensFromEvent<E extends { properties?: Record<string, unknown> } | null>(event: E): E {
  if (!event?.properties) return event;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties)) {
    properties[key] = typeof value === 'string' ? scrubTokensInUrl(value) : value;
  }
  return { ...event, properties } as E;
}
