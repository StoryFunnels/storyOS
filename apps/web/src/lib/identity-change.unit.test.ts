import { describe, expect, it } from 'vitest';
import { isIdentityChange } from './identity-change';

/**
 * #468 — the security property, as a test that fails if the clear is removed.
 *
 * The bug: the React Query cache is created once per tab and keyed by workspace,
 * not by user, and neither sign-out nor sign-in tears down the React tree. A
 * guest with one grant was painted her consultant's entire sidebar — two spaces,
 * three databases and every admin nav row — until a manual reload.
 *
 * These assert the RULE that decides when the cache is emptied. The "must keep
 * working" cases are as load-bearing as the leak cases: a rule that clears on
 * every render would fix the leak and destroy the reason `staleTime` exists.
 */
describe('#468 identity change — when the client cache must be emptied', () => {
  describe('the leak cases: these MUST clear', () => {
    it('clears when one user is replaced by another (the reported bug)', () => {
      expect(isIdentityChange('admin-1', 'guest-2')).toBe(true);
    });

    it('clears on sign-out, so the outgoing user’s data does not wait in memory', () => {
      expect(isIdentityChange('admin-1', null)).toBe(true);
    });

    it('clears on sign-in after a sign-out, even if the sign-out path never ran', () => {
      // An expired or revoked session, or another tab switching identity, never
      // passes through the sign-out button. Signing in still has to start clean.
      expect(isIdentityChange(null, 'guest-2')).toBe(true);
    });
  });

  describe('the must-keep-working cases: these must NOT clear', () => {
    it('does not clear on the first resolution of a page load', () => {
      // `useSession` reports undefined while loading, so every load passes through
      // "no identity". Treating that as a change would refetch everything, always.
      expect(isIdentityChange(undefined, 'admin-1')).toBe(false);
      expect(isIdentityChange(undefined, null)).toBe(false);
    });

    it('does not clear on a session refresh — same user, renewed token', () => {
      expect(isIdentityChange('admin-1', 'admin-1')).toBe(false);
    });

    it('does not clear while signed out and staying signed out', () => {
      expect(isIdentityChange(null, null)).toBe(false);
    });

    it('does not fire for a workspace switch, which never changes the user id', () => {
      // Switching workspace is the same person; the id it is keyed on is unchanged,
      // so this function is never the thing that clears for it.
      const sameUserThroughout = 'admin-1';
      expect(isIdentityChange(sameUserThroughout, sameUserThroughout)).toBe(false);
    });
  });

  it('treats every distinct id as a distinct person — no substring or prefix matching', () => {
    expect(isIdentityChange('user-1', 'user-10')).toBe(true);
    expect(isIdentityChange('user-10', 'user-1')).toBe(true);
  });
});
