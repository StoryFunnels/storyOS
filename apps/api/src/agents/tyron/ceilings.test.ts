import { describe, expect, it } from 'vitest';
import {
  BULK_CHECKIN_THRESHOLD,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TURNS_PER_RUN,
  checkBulkCheckin,
  checkCeilings,
  checkToolCallCeiling,
  checkTurnCeiling,
} from './ceilings';

/**
 * #357 / ADR-0016 §4. Two things are asserted throughout, and the second is the
 * one that stops a later "safety" change from making Tyron useless:
 *
 * 1. Every ceiling fires when it should.
 * 2. Ordinary work passes straight through untouched.
 *
 * #358 states that pairing explicitly for write safety; it applies just as much
 * here, because a guard that trips early is indistinguishable from a broken
 * agent.
 */
describe('tool-call ceiling (bug guard)', () => {
  it('lets an ordinary multi-step job through untouched', () => {
    // A real job — "add a field to three databases, then link them" — runs a
    // dozen or so calls. None of these may be interrupted.
    for (const calls of [0, 1, 5, 12, MAX_TOOL_CALLS_PER_TURN - 1]) {
      expect(checkToolCallCeiling(calls), `${calls} calls must pass`).toBeNull();
    }
  });

  it('stops AT the cap, not one past it', () => {
    expect(checkToolCallCeiling(MAX_TOOL_CALLS_PER_TURN)).not.toBeNull();
  });

  it('says what was kept, because nothing is rolled back', () => {
    // #357: a stop must never imply work vanished. The user needs to know the
    // completed steps stand, or they will redo them.
    const stop = checkToolCallCeiling(MAX_TOOL_CALLS_PER_TURN)!;
    expect(stop.message).toMatch(/applied|nothing was rolled back/i);
    expect(stop.kind).toBe('tool_calls_per_turn');
  });

  it('is NOT resumable — continuing a loop just re-enters it', () => {
    expect(checkToolCallCeiling(MAX_TOOL_CALLS_PER_TURN)!.resumable).toBe(false);
  });
});

describe('turn ceiling (bug guard)', () => {
  it('lets a normal back-and-forth through', () => {
    expect(checkTurnCeiling(0)).toBeNull();
    expect(checkTurnCeiling(MAX_TURNS_PER_RUN - 1)).toBeNull();
  });

  it('stops at the cap and suggests a smaller step rather than blaming the user', () => {
    const stop = checkTurnCeiling(MAX_TURNS_PER_RUN)!;
    expect(stop.kind).toBe('turns_per_run');
    expect(stop.message).toMatch(/smaller step/i);
    expect(stop.resumable).toBe(false);
  });
});

describe('bulk check-in (UX guard, the resumable one)', () => {
  it('does not fire below the threshold', () => {
    expect(checkBulkCheckin(BULK_CHECKIN_THRESHOLD - 1, 500)).toBeNull();
  });

  it('does not fire when there is nothing left to do', () => {
    // Hitting exactly 50 with 0 remaining is a COMPLETED job. Asking "keep
    // going?" when the answer is "there is nothing to go on with" would be the
    // guard inventing a decision the user does not have to make.
    expect(checkBulkCheckin(BULK_CHECKIN_THRESHOLD, 0)).toBeNull();
    expect(checkBulkCheckin(5000, 0)).toBeNull();
  });

  it('fires at the threshold and states the REMAINING count, not a percentage', () => {
    const stop = checkBulkCheckin(BULK_CHECKIN_THRESHOLD, 1150)!;
    expect(stop.kind).toBe('bulk_checkin');
    expect(stop.message).toContain('50');
    // "1,150 to go" is the number that changes someone's mind.
    expect(stop.message).toContain('1150');
    expect(stop.resumable).toBe(true);
  });

  it('reads correctly for a single remaining record', () => {
    // Grammar in a confirmation is not cosmetic — "there are 1 left" reads as a
    // bug and undermines the number beside it.
    expect(checkBulkCheckin(60, 1)!.message).toMatch(/there is 1 left/);
    expect(checkBulkCheckin(60, 2)!.message).toMatch(/there are 2 left/);
  });
});

describe('checkCeilings — the loop\'s single guard call', () => {
  it('passes ordinary work through', () => {
    expect(checkCeilings({ toolCallsThisTurn: 3, turnsThisRun: 2 })).toBeNull();
    expect(
      checkCeilings({ toolCallsThisTurn: 3, turnsThisRun: 2, bulk: { done: 10, remaining: 90 } }),
    ).toBeNull();
  });

  /**
   * The ordering assertion, and the reason `checkCeilings` exists at all rather
   * than three calls at the call site.
   *
   * A runaway that is ALSO touching many records must report the runaway. If the
   * resumable check-in won, the user would be asked "keep going?" about a loop —
   * inviting them to authorise more of the thing the guard just caught.
   */
  it('reports a bug guard BEFORE offering a resumable check-in', () => {
    const stop = checkCeilings({
      toolCallsThisTurn: MAX_TOOL_CALLS_PER_TURN,
      turnsThisRun: 0,
      bulk: { done: 200, remaining: 800 },
    })!;
    expect(stop.kind).toBe('tool_calls_per_turn');
    expect(stop.resumable).toBe(false);
  });

  it('reports the turn ceiling ahead of the tool-call ceiling', () => {
    const stop = checkCeilings({
      toolCallsThisTurn: MAX_TOOL_CALLS_PER_TURN,
      turnsThisRun: MAX_TURNS_PER_RUN,
    })!;
    expect(stop.kind).toBe('turns_per_run');
  });

  it('reaches the check-in when no bug guard has tripped', () => {
    const stop = checkCeilings({
      toolCallsThisTurn: 5,
      turnsThisRun: 1,
      bulk: { done: 50, remaining: 10 },
    })!;
    expect(stop.kind).toBe('bulk_checkin');
    expect(stop.resumable).toBe(true);
  });
});

describe('the thresholds themselves', () => {
  /**
   * #357 requires the caps be "generous". A tight cap breaks honest multi-step
   * work to catch a rare loop, which trades a common failure for an uncommon one.
   */
  it('leaves room for a genuine multi-step job', () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(20);
    expect(MAX_TURNS_PER_RUN).toBeGreaterThanOrEqual(8);
  });

  /**
   * #357 and #358 both say "around 50". This constant is the single source, so
   * the runtime cannot pause at a different count than the write-safety layer's
   * confirmation predicted.
   */
  it('keeps the bulk threshold where both tickets agreed', () => {
    expect(BULK_CHECKIN_THRESHOLD).toBe(50);
  });
});
