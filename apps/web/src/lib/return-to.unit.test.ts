import { describe, expect, it } from 'vitest';
import { loginPathFor, returnPathFromSearch, withReturnPath } from './return-to';
import { GOOGLE_RETURNING_CALLBACK } from './funnel';

describe('#1394 loginPathFor', () => {
  it('keeps a record link, with its query and hash', () => {
    expect(loginPathFor('/w/ws1/d/db1/r/ABC-12?tab=comments#c3')).toBe(
      `/login?next=${encodeURIComponent('/w/ws1/d/db1/r/ABC-12?tab=comments#c3')}`,
    );
  });
  it('does not loop: the front door and auth pages stay plain', () => {
    for (const p of ['/', '/login', '/login?next=%2Fx', '/signup']) expect(loginPathFor(p)).toBe('/login');
  });
  it('refuses another site', () => {
    for (const p of ['//evil.com', 'https://evil.com/x', '/\\evil.com']) expect(loginPathFor(p)).toBe('/login');
  });
});

describe('#1394 Google return path', () => {
  it('round-trips through the callback and keeps the funnel marker', () => {
    const cb = withReturnPath(GOOGLE_RETURNING_CALLBACK, '/w/ws1/d/db1/r/ABC-12?x=1');
    expect(cb.startsWith(GOOGLE_RETURNING_CALLBACK)).toBe(true);
    expect(returnPathFromSearch(cb.slice(cb.indexOf('?')))).toBe('/w/ws1/d/db1/r/ABC-12?x=1');
  });
  it('adds nothing when there is nothing to return to, or it is unsafe', () => {
    for (const n of [null, undefined, '', '/', '//evil.com', 'https://evil.com']) expect(withReturnPath(GOOGLE_RETURNING_CALLBACK, n)).toBe(GOOGLE_RETURNING_CALLBACK);
  });
  it('reads no path from a hostile or absent next', () => {
    for (const s of ['', '?next=//evil.com', '?next=https://evil.com', '?next=%2F']) expect(returnPathFromSearch(s)).toBeNull();
  });
});
