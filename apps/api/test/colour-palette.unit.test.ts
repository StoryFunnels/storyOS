import { describe, expect, it } from 'vitest';
import {
  LEGACY_CONTAINER_COLORS,
  OPTION_COLORS,
  PALETTE,
  databaseColorSchema,
  spaceColorSchema,
} from '@storyos/schemas';

/**
 * #399 — one palette, three surfaces.
 *
 * There were three hardcoded copies. The database list was a strict PREFIX of
 * the option list; the space list was byte-identical to the database one. So
 * `indigo` was a valid status colour and an invalid database colour, with no
 * rule a user — or an agent — could infer.
 *
 * The ticket warned that its own first draft undercounted at two palettes, so
 * these assert the RELATIONSHIP rather than any fixed number.
 *
 * Lives in the api test suite because `packages/schemas` has no test runner —
 * a test placed next to the code there would never have executed.
 */
describe('every colour list derives from ONE source', () => {
  it('select options offer the whole palette', () => {
    expect([...OPTION_COLORS]).toEqual([...PALETTE]);
  });

  it('databases offer the whole palette', () => {
    expect(databaseColorSchema.options).toEqual([...PALETTE]);
  });

  it('spaces offer the whole palette', () => {
    expect(spaceColorSchema.options).toEqual([...PALETTE]);
  });

  it('the three agree with each other — the actual bug', () => {
    // The regression guard: a future addition can no longer reach one list and
    // skip the others, because there is only one list. This asserts nobody has
    // quietly reintroduced a copy.
    expect(databaseColorSchema.options).toEqual([...OPTION_COLORS]);
    expect(spaceColorSchema.options).toEqual(databaseColorSchema.options);
  });
});

describe('the widening is additive — no existing colour became invalid', () => {
  it('every colour containers used to accept is still accepted', () => {
    /*
     * The ticket's constraint: "no database or option loses its current colour."
     * Narrowing options to ten was the other way to unify these, and it would
     * have invalidated every existing lime/cyan/indigo/magenta/rose option —
     * which is why the decision was to widen rather than cap.
     */
    for (const c of LEGACY_CONTAINER_COLORS) {
      expect(databaseColorSchema.safeParse(c).success, `${c} must stay valid`).toBe(true);
      expect(spaceColorSchema.safeParse(c).success, `${c} must stay valid`).toBe(true);
    }
  });

  it('the five that used to fail on a container now pass', () => {
    // The reported symptom as a test: indigo worked on a status and 422'd on a
    // database.
    for (const c of ['lime', 'cyan', 'indigo', 'magenta', 'rose']) {
      expect(databaseColorSchema.safeParse(c).success, `${c} should be valid on a database`).toBe(true);
    }
  });

  it('a colour outside the palette is still rejected, naming what IS allowed', () => {
    const res = databaseColorSchema.safeParse('navy');
    expect(res.success).toBe(false);
    if (!res.success) {
      // A rejection someone can act on, rather than a bare failure.
      expect(JSON.stringify(res.error.issues)).toContain('indigo');
    }
  });
});
