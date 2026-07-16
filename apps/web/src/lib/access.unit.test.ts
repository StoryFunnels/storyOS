import { describe, expect, it } from 'vitest';
import { atLeast, GRANT_ROLES } from './access';
import type { EffectiveRole } from './access';

/**
 * MN-135: the web hand-duplicates the API's permission ladder (lib/access.ts vs
 * access.service.ts ACCESS_RANK). If the two drift, the UI enables a control the
 * API then refuses. This pins the web ladder to the exact contract, so a change to
 * one forces a change here.
 */

// The order the API's ACCESS_RANK defines (MN-121). If the API adds a rung, this
// array must change too — that's the point.
const LADDER: EffectiveRole[] = ['viewer', 'commenter', 'contributor', 'editor', 'creator', 'admin'];

describe('the permission ladder mirrors the API (MN-121)', () => {
  it('atLeast is monotonic along the ladder', () => {
    for (let i = 0; i < LADDER.length; i++) {
      for (let j = 0; j < LADDER.length; j++) {
        // role i satisfies min j exactly when i is at least as high as j.
        expect(atLeast(LADDER[i], LADDER[j]!), `${LADDER[i]} >= ${LADDER[j]}`).toBe(i >= j);
      }
    }
  });

  it('contributor sits between commenter and editor', () => {
    expect(atLeast('contributor', 'commenter')).toBe(true);
    expect(atLeast('contributor', 'editor')).toBe(false);
  });

  it('undefined access satisfies nothing', () => {
    expect(atLeast(undefined, 'viewer')).toBe(false);
  });

  it('the grantable roles are the ladder minus admin, in order', () => {
    // Grants are viewer..creator; admin is a workspace role, not a scope grant.
    expect(GRANT_ROLES.map((r) => r.value)).toEqual([
      'viewer',
      'commenter',
      'contributor',
      'editor',
      'creator',
    ]);
  });
});
