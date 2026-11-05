import { env } from '../config/env';
import { STATE_MAX_AGE_MS } from './connections.service';

/**
 * #1048 — the cookie that ties a Connections OAuth round-trip to the browser that started it. Set on the 302 from
 * `GET .../connections/oauth/:provider/start` (a top-level navigation, so the browser stores it), read and cleared at
 * `GET /connections/oauth/callback`.
 *
 *  - HttpOnly: no script needs it.
 *  - SameSite=Lax: the provider sends the browser back with a top-level GET, which Lax allows; nothing cross-site can POST it.
 *  - Path limited to the callback's prefix; lives as long as the state does.
 *  - Secure whenever the API is served over https.
 */
export const OAUTH_NONCE_COOKIE = 'storyos_oauth_nonce';
const COOKIE_PATH = '/api/v1/connections/oauth';

function attributes(maxAgeSeconds: number): string {
  const secure = env().API_URL.startsWith('https://') ? '; Secure' : '';
  return `Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export function nonceCookie(nonce: string): string {
  return `${OAUTH_NONCE_COOKIE}=${nonce}; ${attributes(Math.floor(STATE_MAX_AGE_MS / 1000))}`;
}

export function clearNonceCookie(): string {
  return `${OAUTH_NONCE_COOKIE}=; ${attributes(0)}`;
}

/** The nonce from a raw Cookie header, or undefined. Only base64url characters are accepted, so nothing odd reaches the compare. */
export function readNonceCookie(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== OAUTH_NONCE_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
  }
  return undefined;
}
