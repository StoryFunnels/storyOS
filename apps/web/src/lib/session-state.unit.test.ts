import { describe, expect, it } from 'vitest';
import { sessionVerdict } from './session-state';

const none = { data: null, isPending: false };

describe('sessionVerdict (#948)', () => {
  it('a session means authed, even if a stale error is attached', () => {
    expect(sessionVerdict({ data: { user: {} }, isPending: false, error: { status: 502 } })).toBe('authed');
  });
  it('still loading is pending, never signed out', () => {
    expect(sessionVerdict({ data: null, isPending: true })).toBe('pending');
  });
  it('a real 401 or 403 means signed out', () => {
    expect(sessionVerdict({ ...none, error: { status: 401 } })).toBe('signed_out');
    expect(sessionVerdict({ ...none, error: { status: 403 } })).toBe('signed_out');
  });
  it('a 200 with no session means signed out', () => {
    expect(sessionVerdict(none)).toBe('signed_out');
    expect(sessionVerdict({ ...none, error: null })).toBe('signed_out');
  });
  it('502, 503, 504 and any other 5xx mean unavailable, not signed out', () => {
    for (const status of [500, 502, 503, 504]) expect(sessionVerdict({ ...none, error: { status } })).toBe('unavailable');
  });
  it('a network failure (status 0 or none) means unavailable', () => {
    expect(sessionVerdict({ ...none, error: { status: 0 } })).toBe('unavailable');
    expect(sessionVerdict({ ...none, error: {} })).toBe('unavailable');
  });
});
