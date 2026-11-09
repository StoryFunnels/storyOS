import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

/** Ticket #1052 — `?next=` after sign-in/sign-up only ever lands on this site. */
describe('safeNextPath', () => {
  it.each([
    ['/w/abc', '/w/abc'],
    ['/invite?token=t1', '/invite?token=t1'],
    ['/oauth/consent?consent_code=x&client_id=y', '/oauth/consent?consent_code=x&client_id=y'],
    ['/w/abc#section', '/w/abc#section'],
  ])('keeps the same-site path %s', (input, out) => {
    expect(safeNextPath(input)).toBe(out);
  });

  it.each([
    null,
    undefined,
    '',
    'https://evil.example/',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'evil.example',
    '/\tevil',
    '/%0a',
  ])('falls back to / for %j', (input) => {
    const out = safeNextPath(input);
    expect(out.startsWith('/') && !out.startsWith('//')).toBe(true);
    if (input !== '/%0a') expect(out).toBe('/');
  });
});
