import { describe, expect, it } from 'vitest';
// @ts-expect-error -- Next's vendored path-to-regexp (the one it compiles `headers()` sources with) ships no types.
import { pathToRegexp as untyped } from 'next/dist/compiled/path-to-regexp';
import {
  cspForRequest,
  cspHeaderName,
  cspMode,
  contentSecurityPolicy,
  generateNonce,
  isEmbeddablePath,
  securityHeaders,
} from './security-headers.mjs';

/** Ticket #1042: which static headers each kind of page gets, matched the way Next matches a `headers()` source. */
const pathToRegexp = untyped as (source: string, keys: unknown[], opts: object) => RegExp;
const rules = securityHeaders();

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

const ENV = { apiUrl: 'https://api.example.test', posthogHost: 'https://ph.example.test', webUrl: 'https://app.example.test' };
const directive = (csp: string, name: string) => csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));

describe('#1042 web static security headers', () => {
  it.each(['/', '/w/abc/settings', '/invite/xyz', '/admin', '/fonts/inter.woff2', '/s/token', '/oauth/consent', '/favicon.ico', '/vx/token', '/ff'])(
    'app page %s cannot be framed',
    (path) => {
      expect(headersFor(path)['X-Frame-Options']).toBe('DENY');
    },
  );

  it.each(['/f/token', '/f/token?embed=1', '/v/token', '/v/token/'])('embeddable page %s can be framed', (path) => {
    expect(headersFor(path.split('?')[0]!)['X-Frame-Options']).toBeUndefined();
  });

  it.each(['/', '/w/abc', '/f/token', '/v/token'])('%s gets nosniff, HSTS and a referrer policy', (path) => {
    const h = headersFor(path);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('carries no CSP statically: the policy has a per-request nonce, so only the proxy may set it', () => {
    for (const rule of rules) {
      expect(rule.headers.map((h: { key: string }) => h.key.toLowerCase())).not.toContain('content-security-policy');
      expect(rule.headers.map((h: { key: string }) => h.key.toLowerCase())).not.toContain('content-security-policy-report-only');
    }
  });
});

describe('#1238 the enforced Content-Security-Policy', () => {
  const csp = contentSecurityPolicy(ENV, { embeddable: false, nonce: 'abc123' });

  it('scripts run only with the request nonce: no unsafe-inline, no unsafe-eval, no host allow-list', () => {
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it('allows eval in script-src only in dev', () => {
    expect(directive(contentSecurityPolicy(ENV, { embeddable: false, nonce: 'n', dev: true }), 'script-src')).toContain("'unsafe-eval'");
    expect(directive(contentSecurityPolicy(ENV, { embeddable: false, nonce: 'n', dev: false }), 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('styles are same-origin or inline, and carry no nonce or hash (either would make browsers ignore unsafe-inline)', () => {
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src[^;]*(nonce-|sha256-)/);
  });

  it('locks down objects, base URI and form targets, and sends reports to the same-origin sink', () => {
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'report-uri')).toBe('report-uri /csp-report');
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
  });

  it('the app cannot be framed; the share routes can', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(contentSecurityPolicy(ENV, { embeddable: true, nonce: 'n' }), 'frame-ancestors')).toBe('frame-ancestors *');
  });

  it('the CSP lets the app reach its API and PostHog, and only those', () => {
    const c = contentSecurityPolicy({ ...ENV, apiUrl: 'https://api.example.test/', posthogHost: 'https://ph.example.test' }, { embeddable: false, nonce: 'n' });
    expect(directive(c, 'connect-src')).toBe("connect-src 'self' https://api.example.test https://ph.example.test");
  });

  it('a relative or missing URL adds nothing beyond self', () => {
    const c = contentSecurityPolicy({ apiUrl: '', posthogHost: '/ingest', webUrl: undefined }, { embeddable: false, nonce: 'n' });
    expect(directive(c, 'connect-src')).toBe("connect-src 'self'");
  });

  it('upgrades insecure requests only on an https deployment, and allows http images only on plain http', () => {
    const https = contentSecurityPolicy({ ...ENV, webUrl: 'https://app.example.test' }, { embeddable: false, nonce: 'n' });
    expect(https).toContain('upgrade-insecure-requests');
    expect(directive(https, 'img-src')).toBe("img-src 'self' data: blob: https:");
    for (const webUrl of ['http://localhost', 'http://localhost:8080', '', undefined, 'not a url']) {
      const http = contentSecurityPolicy({ ...ENV, webUrl }, { embeddable: false, nonce: 'n' });
      expect(http, `webUrl=${String(webUrl)}`).not.toContain('upgrade-insecure-requests');
      expect(directive(http, 'img-src')).toBe("img-src 'self' data: blob: https: http:");
    }
  });

  it('derives every origin from the env: no host is baked into the policy', () => {
    const c = contentSecurityPolicy({ apiUrl: 'https://one.example', posthogHost: undefined, webUrl: 'http://localhost' }, { embeddable: false, nonce: 'n' });
    expect(c).not.toMatch(/storyos|posthog\.com|localhost:3001/);
    expect(directive(c, 'connect-src')).toBe("connect-src 'self' https://one.example");
  });
});

describe('#1238 enforce vs report-only', () => {
  it('enforces by default, and for anything that is not exactly report-only', () => {
    for (const v of [undefined, '', 'enforce', 'enforced', 'report_only', 'off', 'false']) expect(cspMode(v), String(v)).toBe('enforce');
  });

  it('report-only is the one switch back, case and whitespace tolerant', () => {
    for (const v of ['report-only', 'Report-Only', ' report-only ']) expect(cspMode(v)).toBe('report-only');
  });

  it('the header name follows the mode', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
  });

  it('an app page is enforced by default and carries the whole policy in the enforced header', () => {
    const r = cspForRequest(ENV, { pathname: '/w/abc', nonce: 'n1' });
    expect(r.name).toBe('Content-Security-Policy');
    expect(r.value).toContain("'nonce-n1'");
    expect(r.framing).toBeNull();
  });

  it('report-only keeps frame-ancestors enforced on app pages and adds nothing on the embeddable routes', () => {
    const app = cspForRequest({ ...ENV, mode: 'report-only' }, { pathname: '/w/abc', nonce: 'n1' });
    expect(app.name).toBe('Content-Security-Policy-Report-Only');
    expect(app.framing).toEqual({ name: 'Content-Security-Policy', value: "frame-ancestors 'none'" });
    for (const path of ['/f/tok', '/v/tok/']) {
      const share = cspForRequest({ ...ENV, mode: 'report-only' }, { pathname: path, nonce: 'n1' });
      expect(share.framing).toBeNull();
      expect(directive(share.value, 'frame-ancestors')).toBe('frame-ancestors *');
    }
  });

  it('the embeddable routes are enforced too, keeping frame-ancestors *', () => {
    for (const path of ['/f/tok', '/v/tok', '/v/tok/']) {
      const r = cspForRequest(ENV, { pathname: path, nonce: 'n1' });
      expect(r.name).toBe('Content-Security-Policy');
      expect(directive(r.value, 'frame-ancestors')).toBe('frame-ancestors *');
    }
    expect(isEmbeddablePath('/vx/tok')).toBe(false);
    expect(isEmbeddablePath('/f')).toBe(false);
  });
});

describe('#1238 the nonce', () => {
  it('is 128 random bits of base64, and different on every call', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('every request gets its own nonce in its own policy', () => {
    const a = cspForRequest(ENV, { pathname: '/', nonce: generateNonce() });
    const b = cspForRequest(ENV, { pathname: '/', nonce: generateNonce() });
    expect(a.value).not.toBe(b.value);
    expect(a.value).toContain(`'nonce-${a.nonce}'`);
    expect(a.value).not.toContain(b.nonce);
  });
});
