import { describe, expect, it } from 'vitest';
import { isConvergingStep } from '../src/automations/automations.service';

/**
 * #275 — the convergence predicate behind the loop guard.
 *
 * Tested at the unit level ON PURPOSE, and the reason matters: a converging
 * self-trigger CANNOT BE AUTHORED in StoryOS today. `set_values` interpolates
 * tokens into strings and has no arithmetic, so "set Remaining to {Remaining}
 * minus 1" produces the text "4 - 1" and a number field rejects it. There is no
 * way to write a decrementing rule, so there is no end-to-end path to exercise.
 *
 * That is recorded on #275 and filed separately rather than papered over: an
 * integration test here could only have asserted a chain that never converges,
 * which would have looked like coverage and proven nothing — the #328 mistake.
 *
 * What IS end-to-end tested is the half that is reachable: a non-converging
 * self-trigger is still halted, now with a diagnostic naming the rule.
 */
const FIELD = 'field-1';

describe('isConvergingStep (#275)', () => {
  it('is true only when the watched number strictly decreases', () => {
    expect(isConvergingStep({ [FIELD]: { from: 5, to: 4 } }, FIELD)).toBe(true);
    expect(isConvergingStep({ [FIELD]: { from: 1, to: 0 } }, FIELD)).toBe(true);
    expect(isConvergingStep({ [FIELD]: { from: 0, to: -1 } }, FIELD)).toBe(true);
  });

  it('is false when the number rises — that is the runaway case', () => {
    expect(isConvergingStep({ [FIELD]: { from: 4, to: 5 } }, FIELD)).toBe(false);
  });

  it('is false when the number does not move', () => {
    // A chain that keeps firing without changing anything is not converging;
    // it is a loop that has stopped making progress.
    expect(isConvergingStep({ [FIELD]: { from: 3, to: 3 } }, FIELD)).toBe(false);
  });

  it('is false for non-numeric changes — text has no direction', () => {
    expect(isConvergingStep({ [FIELD]: { from: 'a', to: 'b' } }, FIELD)).toBe(false);
    expect(isConvergingStep({ [FIELD]: { from: null, to: 3 } }, FIELD)).toBe(false);
    expect(isConvergingStep({ [FIELD]: { from: 3, to: null } }, FIELD)).toBe(false);
  });

  it('is false when the rule watches ANY field', () => {
    // An unqualified record_updated has no single number whose descent could
    // mean convergence, so it must never earn the allowance.
    expect(isConvergingStep({ [FIELD]: { from: 5, to: 4 } }, null)).toBe(false);
    expect(isConvergingStep({ [FIELD]: { from: 5, to: 4 } }, undefined)).toBe(false);
  });

  it('is false when the watched field is not among the changes', () => {
    expect(isConvergingStep({ other: { from: 5, to: 4 } }, FIELD)).toBe(false);
    expect(isConvergingStep(undefined, FIELD)).toBe(false);
  });
});
