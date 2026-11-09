import { describe, expect, it } from 'vitest';
// @ts-expect-error -- Next's vendored path-to-regexp (the one it compiles `headers()` sources with) ships no types.
import { pathToRegexp as untyped } from 'next/dist/compiled/path-to-regexp';
import { contentSecurityPolicy, securityHeaders } from './security-headers.mjs';

/** Ticket #1042: which headers each kind of page gets, matched the way Next matches a `headers()` source. */
const pathToRegexp = untyped as (source: string, keys: unknown[], opts: object) => RegExp;
const rules = securityHeaders({ apiUrl: 'https://api.storyos.dev', posthogHost: 'https://us.i.posthog.com' });

function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!pathToRegexp(rule.source, [], { strict: true, sensitive: false, delimiter: '/' }).test(path)) continue;
    for (const h of rule.headers) {
      expect(out[h.key], `${h.key} set twice for ${path}`).toBeUndefined();
      out[h.key] = h.value;
    }
  }
  return out;
}

describe('#1042 web security headers', () => {
  it.each(['/', '/w/abc/settings', '/invite/xyz', '/admin', '/fonts/inter.woff2', '/s/token', '/oauth/consent', '/favicon.ico', '/vx/token', '/ff'])(
    'app page %s cannot be framed',
    (path) => {
      const h = headersFor(path);
      expect(h['X-Frame-Options']).toBe('DENY');
      expect(h['Content-Security-Policy']).toBe("frame-ancestors 'none'");
      expect(h['Content-Security-Policy-Report-Only']).toContain("frame-ancestors 'none'");
    },
  );

  it.each(['/f/token', '/f/token?embed=1', '/v/token', '/v/token/'])('embeddable page %s can be framed', (path) => {
    const h = headersFor(path.split('?')[0]!);
    expect(h['X-Frame-Options']).toBeUndefined();
    expect(h['Content-Security-Policy']).toBeUndefined();
    expect(h['Content-Security-Policy-Report-Only']).toContain('frame-ancestors *');
  });

  it.each(['/', '/w/abc', '/f/token', '/v/token'])('%s gets nosniff, HSTS and a referrer policy', (path) => {
    const h = headersFor(path);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('the CSP lets the app reach its API and PostHog, and only those', () => {
    const csp = contentSecurityPolicy({ apiUrl: 'https://api.storyos.dev/', posthogHost: 'https://us.i.posthog.com' }, { embeddable: false });
    expect(csp).toContain("connect-src 'self' https://api.storyos.dev https://us.i.posthog.com;");
  });

  it('a relative or missing URL adds nothing beyond self', () => {
    const csp = contentSecurityPolicy({ apiUrl: undefined, posthogHost: '/ingest' }, { embeddable: false });
    expect(csp).toContain("connect-src 'self';");
  });
});
