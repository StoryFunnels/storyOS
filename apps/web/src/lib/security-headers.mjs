// Ticket #1042: security headers for every page the web app serves. Plain .mjs (not .ts) because next.config.mjs
// imports it at build time, before any TypeScript compile; `security-headers.unit.test.ts` covers it.
/* global URL */

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

/**
 * The baseline Content-Security-Policy, shipped as Report-Only first: browsers log what it would block (DevTools
 * console) without blocking anything. Once staging shows no violations it can move to the enforced header.
 *
 * - `'unsafe-inline'` scripts: the App Router streams inline bootstrap scripts; nonces would make every page dynamic.
 * - `connect-src` adds the API origin (NEXT_PUBLIC_API_URL, inlined at build time) and PostHog when it is set as an
 *   absolute URL; the default `/ingest` proxy is same-origin.
 * - `img-src https:`: avatars and link previews come from arbitrary hosts.
 *
 * @param {{ apiUrl?: string, posthogHost?: string }} env
 * @param {{ embeddable: boolean }} opts
 * @returns {string}
 */
export function contentSecurityPolicy(env, { embeddable }) {
  const connect = ["'self'", originOf(env.apiUrl), originOf(env.posthogHost)].filter(Boolean);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embeddable ? '*' : "'none'"}`,
  ].join('; ');
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
 * The `headers()` entries for next.config.mjs. Two rules with no overlapping keys: everything except the embeddable
 * routes is unframeable (enforced `frame-ancestors 'none'` + X-Frame-Options for old browsers); the embeddable routes
 * get the same report-only baseline with `frame-ancestors *`.
 *
 * @param {{ apiUrl?: string, posthogHost?: string }} env
 */
export function securityHeaders(env) {
  const embeddable = EMBEDDABLE_PREFIXES.map((p) => p.slice(1, -1)).join('|');
  return [
    {
      source: `/:path((?!(?:${embeddable})/).*)`,
      headers: [
        ...COMMON,
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy(env, { embeddable: false }) },
      ],
    },
    {
      // One regex rule, not `/f/:path*`: that form misses `/v/token/`, and the app does not strip trailing slashes.
      source: `/:path((?:${embeddable})/.*)`,
      headers: [
        ...COMMON,
        { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy(env, { embeddable: true }) },
      ],
    },
  ];
}
