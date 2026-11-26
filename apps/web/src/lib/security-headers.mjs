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

/** The one value of `CSP_MODE` that is recognised. Compared exactly: no trimming, no case folding. */
export const CSP_REPORT_ONLY = 'report-only';

/**
 * Ticket #1238: whether the policy is ENFORCED or only reported. Enforced is the default, and anything that is not EXACTLY
 * `report-only` enforces (ticket #1343: no trimming or lower-casing, so `Report-Only` and ` report-only` enforce too, which is
 * what the self-hosting configuration page says): a typo must not silently switch the protection off. See `cspModeProblem` for
 * the boot-time warning that makes such a typo visible. `report-only` is the operator's fast way back if an enforced policy
 * breaks a page: set `CSP_MODE=report-only` and restart the web container (it is read per request, so no rebuild).
 *
 * @param {string | undefined} value
 * @returns {'enforce' | 'report-only'}
 */
export function cspMode(value) {
  return value === CSP_REPORT_ONLY ? 'report-only' : 'enforce';
}

/**
 * Ticket #1343: a one-line warning for a `CSP_MODE` that is set but not recognised, or null when it is unset, empty or exactly
 * `report-only`. `src/instrumentation.ts` logs it once at boot, so an operator who typed `Report-Only` (and so still has an
 * ENFORCED policy while believing it is relaxed) finds out from the log rather than from a page that stays broken.
 *
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function cspModeProblem(value) {
  if (value === undefined || value === '' || value === CSP_REPORT_ONLY) return null;
  const shown = JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  return `CSP_MODE=${shown} is not recognised, so the Content-Security-Policy is ENFORCED. The only accepted value is exactly "${CSP_REPORT_ONLY}" (or leave it unset).`;
}

/** The response header that carries the policy in a given mode. */
export function cspHeaderName(mode) {
  return mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** Where browsers POST violation reports: the web app's own `/csp-report` route handler, same origin on every deployment. */
export const CSP_REPORT_PATH = '/csp-report';

/**
 * The CSP hash of the one `<style>` sheet sonner (the toast library) inserts when its module loads, before any component runs, so
 * it cannot be given a nonce. It is the sha256 of that sheet's text, taken from the installed package; `security-headers.unit.test.ts`
 * recomputes it from `node_modules/sonner`, so a sonner upgrade that changes the sheet fails that test instead of silently
 * un-styling every toast.
 */
export const SONNER_STYLE_HASH = "'sha256-CIxDM5jnsGiKqXs2v7NKCY5MzdR9gu6TtiMJrDw29AY='";

/**
 * The CSP hash of an EMPTY `<style>` element (the sha256 of ''). Sonner appends its `<style>` to `<head>` first and fills it a moment
 * later, and browsers check the element when it is inserted, so without this each page that loads sonner logs one violation for a
 * sheet with nothing in it. An empty style element applies no rules, so allowing it widens nothing.
 */
export const EMPTY_STYLE_HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";

/**
 * The Content-Security-Policy for one response (ticket #1238; baseline from ticket #1042).
 *
 * - Scripts: `'self'` plus a per-request nonce and `'strict-dynamic'`. No `'unsafe-inline'` and no `'unsafe-eval'` (eval only in
 *   dev, `dev: true`: React's debugging needs it). A nonce needs a per-request render, so the policy is built by `src/proxy.ts`, not
 *   by the static `headers()` in next.config. With `'strict-dynamic'` browsers ignore host allow-lists, so only nonce'd scripts
 *   (and what they load) run: an injected `<script>` or an `onclick=` attribute does not. Called with no nonce it falls back to
 *   `'unsafe-inline'`, which exists only so a caller that has no request (a bare unit test) still gets a well-formed policy.
 * - Styles are split (ticket #1340). `style-src-elem` (`<style>` elements and stylesheets) is `'self'` plus the same per-request
 *   nonce and no `'unsafe-inline'`, so an injected `<style>` block does not apply. The libraries that create `<style>` elements at
 *   runtime are given the nonce (the editor's `injectNonce`); sonner injects its sheet at import time
 *   and cannot take one, so that one fixed sheet is allowed by its hash (`SONNER_STYLE_HASH`, checked against the installed
 *   package by a unit test), plus the hash of an empty element (`EMPTY_STYLE_HASH`) because it inserts the element before filling it.
 *   `style-src-attr` (style ATTRIBUTES) stays `'unsafe-inline'` on its own: React renders every `style={{…}}` prop as an attribute and an attribute cannot carry a nonce. The base `style-src` is only the fallback for a
 *   browser that predates the split directives; those browsers ignore it as soon as they know the split ones. Called with no
 *   nonce, `style-src-elem` falls back to `'unsafe-inline'`, as the script directive does. NB a nonce or hash in a style
 *   directive makes browsers IGNORE `'unsafe-inline'` in that same directive, so a directive is all-or-nothing: never add a nonce
 *   to `style-src-attr`.
 * - `connect-src` adds the API origin (NEXT_PUBLIC_API_URL) and PostHog (NEXT_PUBLIC_POSTHOG_HOST) when set as absolute URLs; the
 *   default same-origin `/api` and `/ingest` paths are covered by `'self'`. BOTH are BUILD-time values (ticket #1343): Next
 *   inlines a `NEXT_PUBLIC_*` that is set at build into the proxy bundle as it does into the client bundle. Set them when the
 *   image is built: the client can only call the origin it was built with, so a value given only to the running container is
 *   not supported (the policy and the client would disagree). Only `WEB_URL` and `CSP_MODE` are read at request time.
 * - `img-src https:` (plus `http:` on a plain-HTTP deployment): avatars and link previews come from arbitrary hosts.
 * - `upgrade-insecure-requests` only when WEB_URL is https: on a plain-HTTP self-host it would rewrite every same-origin
 *   subresource request to an https one that nothing serves. Nothing here is a hard-coded host: the API origin and the PostHog
 *   origin come from the deployment's build-time env, the scheme from its runtime `WEB_URL`.
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
  const styleElem = ["'self'", ...(nonce ? [...n, SONNER_STYLE_HASH, EMPTY_STYLE_HASH] : ["'unsafe-inline'"])];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `style-src-elem ${styleElem.join(' ')}`,
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
 * It deliberately returns ONE header. Ticket #1343: until then, report-only mode also had the proxy set a second, enforced
 * `Content-Security-Policy: frame-ancestors 'none'` (so a rollback would not un-protect against clickjacking), and that cost every
 * script its nonce. Next copies every header a proxy sets on the RESPONSE back onto the request it renders, then reads the nonce from
 * `content-security-policy` before `content-security-policy-report-only`; the framing-only value has no `script-src`, so no nonce was
 * found and the report-only policy reported every one of the app's own scripts. The enforced framing header now comes from the
 * static `securityHeaders()` instead, which Next applies without feeding it back into the render.
 *
 * @param {{ apiUrl?: string, posthogHost?: string, webUrl?: string, mode?: string, dev?: boolean }} env
 * @param {{ pathname: string, nonce: string }} req
 * @returns {{ name: string, value: string, nonce: string }}
 */
export function cspForRequest(env, { pathname, nonce }) {
  const embeddable = isEmbeddablePath(pathname);
  const value = contentSecurityPolicy(env, { embeddable, nonce, dev: env.dev });
  return { name: cspHeaderName(cspMode(env.mode)), value, nonce };
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
 * (`X-Frame-Options: DENY` plus an ENFORCED `Content-Security-Policy: frame-ancestors 'none'`, ticket #1343, so clickjacking
 * protection holds in report-only mode too); the embeddable routes get no anti-framing header. The script/style policy itself is
 * NOT here (ticket #1238): it carries a per-request nonce, so `src/proxy.ts` sets it. That is also why the framing-only CSP is here
 * and not in the proxy: see `cspForRequest`.
 */
export function securityHeaders() {
  const embeddable = EMBEDDABLE_PREFIXES.map((p) => p.slice(1, -1)).join('|');
  return [
    {
      source: `/:path((?!(?:${embeddable})/).*)`,
      headers: [...COMMON, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }],
    },
    {
      // One regex rule, not `/f/:path*`: that form misses `/v/token/`, and the app does not strip trailing slashes.
      source: `/:path((?:${embeddable})/.*)`,
      headers: [...COMMON],
    },
  ];
}
