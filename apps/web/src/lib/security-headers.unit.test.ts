import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- Next's vendored path-to-regexp (the one it compiles `headers()` sources with) ships no types.
import { pathToRegexp as untyped } from 'next/dist/compiled/path-to-regexp';
import {
  cspForRequest,
  cspHeaderName,
  cspMode,
  cspModeProblem,
  contentSecurityPolicy,
  generateNonce,
  isEmbeddablePath,
  EMPTY_STYLE_HASH,
  securityHeaders,
  SONNER_STYLE_HASH,
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

  it('carries no script/style policy statically: it has a per-request nonce, so only the proxy may set it', () => {
    for (const rule of rules) {
      expect(rule.headers.map((h: { key: string }) => h.key.toLowerCase())).not.toContain('content-security-policy-report-only');
      for (const h of rule.headers) {
        if (h.key.toLowerCase() === 'content-security-policy') expect(h.value).toBe("frame-ancestors 'none'");
      }
    }
  });

  it.each(['/', '/w/abc/settings', '/invite/xyz', '/oauth/consent'])(
    'app page %s carries an ENFORCED frame-ancestors none statically, so it survives CSP_MODE=report-only (ticket #1343)',
    (path) => {
      expect(headersFor(path)['Content-Security-Policy']).toBe("frame-ancestors 'none'");
    },
  );

  it.each(['/f/token', '/v/token', '/v/token/'])('embeddable page %s gets no static CSP at all', (path) => {
    expect(headersFor(path)['Content-Security-Policy']).toBeUndefined();
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

  it('ticket #1340: style ELEMENTS need the request nonce and never get unsafe-inline', () => {
    const elem = directive(csp, 'style-src-elem');
    expect(elem).toBe(`style-src-elem 'self' 'nonce-abc123' ${SONNER_STYLE_HASH} ${EMPTY_STYLE_HASH}`);
    expect(elem).toContain("'self'");
    expect(elem).not.toContain("'unsafe-inline'");
  });

  it('ticket #1340: style ATTRIBUTES keep unsafe-inline on their own, with no nonce or hash (either would make browsers ignore it)', () => {
    // React renders every style={{…}} prop as an attribute, which cannot carry a nonce: this must stay allowed.
    expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
  });

  it('ticket #1340: the base style-src is only the legacy fallback and still allows same-origin and inline', () => {
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('ticket #1340: with no nonce the style policy stays well-formed and elements fall back to unsafe-inline, like scripts', () => {
    const bare = contentSecurityPolicy(ENV, { embeddable: false });
    expect(directive(bare, 'style-src-elem')).toBe("style-src-elem 'self' 'unsafe-inline'");
    expect(directive(bare, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
    expect(bare).not.toMatch(/nonce-|undefined|null/);
    // Still one directive each: a duplicate would make browsers ignore the second.
    for (const d of ['style-src', 'style-src-elem', 'style-src-attr']) {
      expect(bare.split('; ').filter((x) => x.startsWith(`${d} `))).toHaveLength(1);
    }
  });

  it('ticket #1340: the empty-element hash really is the sha256 of the empty string', () => {
    expect(`'sha256-${createHash('sha256').update('').digest('base64')}'`).toBe(EMPTY_STYLE_HASH);
  });

  it('ticket #1340: the sonner hash is the sha256 of the sheet the installed sonner really inserts', () => {
    const src = readFileSync(createRequire(import.meta.url).resolve('sonner').replace(/index\.js$/, 'index.mjs'), 'utf8');
    const m = src.match(/^__insertCSS\(("(?:[^"\\]|\\.)*")\);?\s*$/m);
    expect(m, 'sonner no longer inserts its sheet with a single __insertCSS("...") call: re-derive SONNER_STYLE_HASH').not.toBeNull();
    const sheet = JSON.parse(m![1]!) as string;
    expect(`'sha256-${createHash('sha256').update(sheet).digest('base64')}'`).toBe(SONNER_STYLE_HASH);
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

  it('report-only is the one switch back, and it is matched EXACTLY (ticket #1343: no case folding, no trimming)', () => {
    expect(cspMode('report-only')).toBe('report-only');
    for (const v of ['Report-Only', 'REPORT-ONLY', ' report-only', 'report-only ', 'report-only\n', 'report-only,x'])
      expect(cspMode(v), JSON.stringify(v)).toBe('enforce');
  });

  it('warns about a CSP_MODE that is set but unrecognised, and about nothing else (ticket #1343)', () => {
    for (const v of [undefined, '', 'report-only']) expect(cspModeProblem(v), String(v)).toBeNull();
    for (const v of ['Report-Only', ' report-only', 'enforced', 'off']) {
      const msg = cspModeProblem(v);
      expect(msg, JSON.stringify(v)).toContain('is not recognised');
      expect(msg).toContain('ENFORCED');
      expect(msg).toContain(JSON.stringify(v));
    }
  });

  it('the warning does not echo an unbounded value', () => {
    expect(cspModeProblem('x'.repeat(5000))?.length).toBeLessThan(300);
  });

  it('report-only reports against the SAME nonce policy, so a rollback stays a useful signal (ticket #1343)', () => {
    for (const path of ['/w/abc', '/f/tok']) {
      const r = cspForRequest({ ...ENV, mode: 'report-only' }, { pathname: path, nonce: 'n1' });
      expect(r.name).toBe('Content-Security-Policy-Report-Only');
      const script = directive(r.value, 'script-src') ?? '';
      expect(script).toContain("'nonce-n1'");
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
      expect(r.value).toBe(cspForRequest(ENV, { pathname: path, nonce: 'n1' }).value);
    }
  });

  it('the header name follows the mode', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
  });

  it('an app page is enforced by default and carries the whole policy in the enforced header', () => {
    const r = cspForRequest(ENV, { pathname: '/w/abc', nonce: 'n1' });
    expect(r.name).toBe('Content-Security-Policy');
    expect(r.value).toContain("'nonce-n1'");
    expect(Object.keys(r).sort()).toEqual(['name', 'nonce', 'value']);
  });

  it('report-only sends ONE header and no framing-only twin from the proxy (ticket #1343)', () => {
    // Next copies every header a proxy sets on the response back onto the request and reads `content-security-policy` before
    // `-report-only`; a framing-only twin has no script-src, so the nonce was not found and no script got one.
    for (const path of ['/w/abc', '/f/tok', '/v/tok/']) {
      const r = cspForRequest({ ...ENV, mode: 'report-only' }, { pathname: path, nonce: 'n1' });
      expect(r.name).toBe('Content-Security-Policy-Report-Only');
      expect(Object.keys(r).sort()).toEqual(['name', 'nonce', 'value']);
    }
    const share = cspForRequest({ ...ENV, mode: 'report-only' }, { pathname: '/f/tok', nonce: 'n1' });
    expect(directive(share.value, 'frame-ancestors')).toBe('frame-ancestors *');
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
