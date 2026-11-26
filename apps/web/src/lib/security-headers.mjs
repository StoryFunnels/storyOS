// Ticket #1042: security headers for every page the web app serves; ticket #1238 moved the Content-Security-Policy from
// report-only to enforced. Plain .mjs (not .ts) because next.config.mjs imports it at build time, before any TypeScript
// compile; `security-headers.unit.test.ts` covers it.
/* global URL, crypto, btoa */

/**
 * Routes that are MEANT to be framed on other sites: `/f/<token>` (embeddable forms) and `/v/<token>` (public
 * views). The share dialogs hand out `<iframe>` snippets for both, so they get no anti-framing headers.
 */
export const EMBEDDABLE_PREFIXES = ['/f/', '/v/'];

/** The origin of an absolute http(s) URL, or null for a relative or unset one (those are covered by 'self'). */
function originOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** True for an absolute https URL. Anything else (unset, relative, http) is treated as a plain-HTTP deployment. */
function isHttps(url) {
  try {
    return !!url && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Ticket #1238: whether the policy is ENFORCED or only reported. Enforced is the default, and anything that is not exactly
 * `report-only` enforces: a typo (`enforced`, `report_only`) must not silently switch the protection off. `report-only` is the
 * operator's fast way back if an enforced policy breaks a page: set `CSP_MODE=report-only` and restart the web container (it is
 * read per request, so no rebuild).
 *
 * @param {string | undefined} value
 * @returns {'enforce' | 'report-only'}
 */
export function cspMode(value) {
  return value?.trim().toLowerCase() === 'report-only' ? 'report-only' : 'enforce';
}

/** The response header that carries the policy in a given mode. */
export function cspHeaderName(mode) {
  return mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** Where browsers POST violation reports: the web app's own `/csp-report` route handler, same origin on every deployment. */
export const CSP_REPORT_PATH = '/csp-report';

/**
 * The Content-Security-Policy for one response (ticket #1238; baseline from ticket #1042).
 *
 * - Scripts: `'self'` plus a per-request nonce and `'strict-dynamic'`. No `'unsafe-inline'` and no `'unsafe-eval'` (eval only in
 *   dev, `dev: true`: React's debugging needs it). A nonce needs a per-request render, so the policy is built by `src/proxy.ts`, not
 *   by the static `headers()` in next.config. With `'strict-dynamic'` browsers ignore host allow-lists, so only nonce'd scripts
 *   (and what they load) run: an injected `<script>` or an `onclick=` attribute does not. Called with no nonce it falls back to
 *   `'unsafe-inline'`, which exists only so a caller that has no request (a bare unit test) still gets a well-formed policy.
 * - Styles: nonce'd or same-origin `<style>` and stylesheets (`style-src-elem`), but style ATTRIBUTES stay `'unsafe-inline'`
 *   (`style-src-attr`): React renders every `style={{…}}` prop as one, and an attribute cannot carry a nonce. Inline style cannot
 *   run script; this is the narrowest rule the app works under.
 * - `connect-src` adds the API origin (NEXT_PUBLIC_API_URL, inlined at build time) and PostHog when set as absolute URLs; the
 *   default same-origin `/api` and `/ingest` paths are covered by `'self'`.
 * - `img-src https:` (plus `http:` on a plain-HTTP deployment): avatars and link previews come from arbitrary hosts.
 * - `upgrade-insecure-requests` only when WEB_URL is https: on a plain-HTTP self-host it would rewrite every same-origin
 *   subresource request to an https one that nothing serves. Nothing here is a hard-coded host: the API origin, the PostHog
 *   origin and the scheme all come from the deployment's own env.
 *
 * @param {{ apiUrl?: string, posthogHost?: string, webUrl?: string }} env
 * @param {{ embeddable: boolean, nonce?: string, dev?: boolean }} opts
 * @returns {string}
 */
export function contentSecurityPolicy(env, { embeddable, nonce, dev = false }) {
  const connect = ["'self'", originOf(env.apiUrl), originOf(env.posthogHost)].filter(Boolean);
  const https = isHttps(env.webUrl);
  const n = nonce ? [`'nonce-${nonce}'`] : [];
  const script = ["'self'", ...n, ...(nonce ? ["'strict-dynamic'"] : ["'unsafe-inline'"]), ...(dev ? ["'unsafe-eval'"] : [])];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    `style-src ${["'self'", ...n].join(' ')}`,
    `style-src-elem ${["'self'", ...n].join(' ')}`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: https:${https ? '' : ' http:'}`,
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embeddable ? '*' : "'none'"}`,
    `report-uri ${CSP_REPORT_PATH}`,
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** A fresh, unguessable nonce: 128 random bits, base64. One per request, never reused. */
export function generateNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** True when the request path is one of the routes meant to be framed on other sites (the same set `securityHeaders` uses). */
export function isEmbeddablePath(pathname) {
  return EMBEDDABLE_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Everything `src/proxy.ts` needs for one request: the header NAME (enforced or report-only, from `cspMode`) and its VALUE with a
 * fresh nonce. Kept here, not in the proxy, so the unit test exercises the exact code that ships.
 *
 * `framing` is set in report-only mode on the pages that must not be framed: the old baseline (ticket #1042) always ENFORCED
 * `frame-ancestors 'none'`, and a switch back to report-only must not quietly un-protect against clickjacking.
 *
 * @param {{ apiUrl?: string, posthogHost?: string, webUrl?: string, mode?: string, dev?: boolean }} env
 * @param {{ pathname: string, nonce: string }} req
 * @returns {{ name: string, value: string, nonce: string, framing: { name: string, value: string } | null }}
 */
export function cspForRequest(env, { pathname, nonce }) {
  const embeddable = isEmbeddablePath(pathname);
  const mode = cspMode(env.mode);
  const value = contentSecurityPolicy(env, { embeddable, nonce, dev: env.dev });
  const framing = mode === 'report-only' && !embeddable ? { name: cspHeaderName('enforce'), value: "frame-ancestors 'none'" } : null;
  return { name: cspHeaderName(mode), value, nonce, framing };
}

/** Headers for every response, framed or not. */
const COMMON = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Browsers ignore HSTS on plain-HTTP responses, so a self-host on :80 is unaffected. No includeSubDomains: the
  // app's domain may share a parent with hosts that are not ours to pin.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

/**
 * The static `headers()` entries for next.config.mjs. Everything except the embeddable routes is unframeable
 * (`X-Frame-Options: DENY`; the matching `frame-ancestors 'none'` rides in the CSP); the embeddable routes get no anti-framing
 * header. The Content-Security-Policy itself is NOT here (ticket #1238): it carries a per-request nonce, so `src/proxy.ts` sets it.
 */
export function securityHeaders() {
  const embeddable = EMBEDDABLE_PREFIXES.map((p) => p.slice(1, -1)).join('|');
  return [
    {
      source: `/:path((?!(?:${embeddable})/).*)`,
      headers: [...COMMON, { key: 'X-Frame-Options', value: 'DENY' }],
    },
    {
      // One regex rule, not `/f/:path*`: that form misses `/v/token/`, and the app does not strip trailing slashes.
      source: `/:path((?:${embeddable})/.*)`,
      headers: [...COMMON],
    },
  ];
}
