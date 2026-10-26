import { describe, expect, it } from 'vitest';
import { baseUrlSummary, httpBaseUrlProblem, needsBaseUrl } from './http-base-url';

describe('the base URL check (#1035)', () => {
  it.each(['https://api.example.com', 'https://api.example.com/v1', 'http://localhost:8080/api', ' https://api.example.com/v1/ '])(
    'accepts %j',
    (v) => expect(httpBaseUrlProblem(v)).toBeNull(),
  );

  // Mirrors the API: each of these would let a credential leave, or is not an address at all.
  it.each([
    ['', /one address/],
    ['   ', /one address/],
    ['api.example.com', /not a valid address/],
    ['not a url', /not a valid address/],
    ['ftp://api.example.com', /https/],
    ['javascript:alert(1)', /https/],
    ['https://user:pass@api.example.com', /username and password/],
    ['https://good.example.com@evil.example.com', /username and password/],
    ['https://api.example.com/v1?key=1', /after \?/],
    ['https://api.example.com/v1#frag', /after \?/],
  ])('refuses %j', (v, why) => {
    expect(httpBaseUrlProblem(v)).toMatch(why);
  });
});

describe('what the connection row says (#1035)', () => {
  it('only HTTP connections carry the badge, and only when the API flags them', () => {
    expect(needsBaseUrl({ provider: 'http', needs_base_url: true })).toBe(true);
    expect(needsBaseUrl({ provider: 'http', needs_base_url: false })).toBe(false);
    expect(needsBaseUrl({ provider: 'http' })).toBe(false);
    expect(needsBaseUrl({ provider: 'resend', needs_base_url: true })).toBe(false);
  });

  it('names where the credential goes once there is a base URL, and says nothing when there is not', () => {
    expect(baseUrlSummary({ provider: 'http', base_url: 'https://api.example.com/v1' })).toBe('Sends its credential only to https://api.example.com/v1');
    expect(baseUrlSummary({ provider: 'http', base_url: null, needs_base_url: true })).toBeNull();
    expect(baseUrlSummary({ provider: 'http', base_url: 'https://x', needs_base_url: true })).toBeNull();
    expect(baseUrlSummary({ provider: 'resend', base_url: 'https://x' })).toBeNull();
  });
});
