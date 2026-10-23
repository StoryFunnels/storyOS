import { describe, expect, it } from 'vitest';
import { viewConfigSchema } from '@storyos/schemas';
import { isHttpUrl, safeHttpUrl } from '@storyos/schemas';

/**
 * Ticket #1032 — a public form's redirect_url was a stored XSS: zod's `.url()` accepts `javascript:`, the form page assigned it to
 * `window.location.href`, and the script ran on the app's origin with the visitor's session. The rule is "http(s) only", checked on the
 * PARSED protocol, because the browser parses before it navigates.
 */
const ATTACKS = [
  'javascript:alert(1)',
  "javascript:fetch('/api/v1/me/tokens',{method:'POST'})",
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)', // a leading space, which the URL parser strips
  'java\tscript:alert(1)', // a tab inside the scheme, which it strips too
  'java\nscript:alert(1)',
  'javascript://%0aalert(1)', // the comment-line variant: a // after the scheme, then a newline and the payload
  'javascript://example.com/%0Aalert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/uuid',
  'ftp://example.com/x',
  '//evil.example/x', // protocol-relative: not an absolute URL at all
  '/relative/path',
  'example.com',
  '',
];
const FINE = ['https://example.com/thanks', 'http://example.com', 'HTTPS://EXAMPLE.COM/x', 'https://example.com/a?b=c#d', 'https://example.com/javascript:alert(1)'];

describe('isHttpUrl / safeHttpUrl (ticket #1032)', () => {
  it.each(ATTACKS)('refuses %j', (value) => {
    expect(isHttpUrl(value)).toBe(false);
    expect(safeHttpUrl(value)).toBeNull();
  });
  it.each(FINE)('accepts %j', (value) => {
    expect(isHttpUrl(value)).toBe(true);
    expect(safeHttpUrl(value)).toBe(value);
  });
  it('refuses a non-string (a stored value of the wrong type is not a URL)', () => {
    for (const v of [null, undefined, 42, {}, ['https://example.com']]) expect(safeHttpUrl(v)).toBeNull();
  });
});

describe('the form config schema (the REST controller and the MCP tools both validate with it)', () => {
  const base = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
  const parse = (redirect_url: string) => viewConfigSchema.safeParse({ ...base, form: { title: 'T', fields: [], redirect_url } });
  it.each(ATTACKS.filter((a) => a !== ''))('rejects redirect_url %j', (value) => {
    expect(parse(value).success).toBe(false);
  });
  it('still accepts a real https redirect, and an absent one', () => {
    expect(parse('https://example.com/thanks').success).toBe(true);
    expect(viewConfigSchema.safeParse({ ...base, form: { title: 'T', fields: [] } }).success).toBe(true);
  });
  it('says why, in words', () => {
    const r = parse('javascript:alert(1)');
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toMatch(/http/);
  });
});
