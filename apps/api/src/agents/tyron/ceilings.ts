/**
 * Tyron's ceilings (#357, ADR-0016 §4).
 *
 * These are **UX and bug guards, NOT cost controls.** #353 decided deliberately
 * that there is no spend ceiling, and that decision must not take these with it
 * by association — an agent looping on itself never finishes, which is broken at
 * any price, and an unreviewed thousand-row edit is a bad experience even if the
 * tokens were free.
 *
 * Enforced in the turn loop rather than at the model boundary, because the loop
 * is the only place that can see the whole conversation. A cap checked inside the
 * model client would count one request and miss the cycle.
 *
 * Every limit produces a CLEAR STOP: a message saying what happened and what
 * remains. Never a silent halt, never an endless spinner — #357's wording, and
 * the failure mode it names is the one users report as "it just stopped".
 */

/**
 * Generous on purpose. A real multi-step job ("add a field to each of these
 * three databases, then link them") legitimately runs a dozen or more calls, so
 * a tight cap would break honest work to catch a rare loop. The number only has
 * to be low enough that a runaway is stopped in seconds.
 */
export const MAX_TOOL_CALLS_PER_TURN = 40;

/**
 * A thread is a conversation, not a session — #359 keeps them for months. This
 * bounds one continuous *run*, not how long a user may keep talking: it counts
 * assistant turns in a single request cycle, so a thread the user returns to
 * tomorrow starts fresh.
 */
export const MAX_TURNS_PER_RUN = 12;

/**
 * The check-in threshold. "Around 50" in both #357 and #358; fixed here so the
 * runtime and the write-safety layer cannot disagree about where it sits — two
 * copies of this number would be a bug nobody notices until a bulk edit pauses
 * at a different count than the confirmation predicted.
 */
export const BULK_CHECKIN_THRESHOLD = 50;

export type CeilingKind = 'tool_calls_per_turn' | 'turns_per_run' | 'bulk_checkin';

export interface CeilingStop {
  kind: CeilingKind;
  /** Shown to the user verbatim. Says what happened AND what remains. */
  message: string;
  /** True when the user can say "keep going" — a check-in, not a failure. */
  resumable: boolean;
}

/**
 * Has this turn made too many tool calls?
 *
 * Returns a stop rather than throwing: a ceiling is an outcome to report, not an
 * exception to surface. Throwing here would land in a generic error handler and
 * produce exactly the opaque failure this guard exists to prevent.
 */
export function checkToolCallCeiling(callsMade: number, max = MAX_TOOL_CALLS_PER_TURN): CeilingStop | null {
  if (callsMade < max) return null;
  return {
    kind: 'tool_calls_per_turn',
    message:
      `I stopped after ${max} steps in one turn, which is my limit for a single request. ` +
      `Everything I did before stopping has been applied — nothing was rolled back. ` +
      `Tell me what to do next and I'll carry on from here.`,
    // Not resumable as the SAME turn: the point of the cap is to break a cycle,
    // and "continue?" on a loop just re-enters it. A new instruction is required.
    resumable: false,
  };
}

export function checkTurnCeiling(turnsTaken: number, max = MAX_TURNS_PER_RUN): CeilingStop | null {
  if (turnsTaken < max) return null;
  return {
    kind: 'turns_per_run',
    message:
      `I've gone back and forth ${max} times on this without finishing, so I've stopped ` +
      `rather than keep going in circles. What I completed is saved. It would help to break this into a ` +
      `smaller step.`,
    resumable: false,
  };
}

/**
 * The bulk check-in — the one ceiling that IS resumable, because it is not
 * protecting against a bug. It exists so nobody discovers a 1,200-row change
 * after the fact.
 *
 * `remaining` is stated explicitly rather than implied by a total, because "1,150
 * to go" is the number that changes someone's mind, and a percentage is not.
 */
export function checkBulkCheckin(done: number, remaining: number): CeilingStop | null {
  if (done < BULK_CHECKIN_THRESHOLD || remaining <= 0) return null;
  return {
    kind: 'bulk_checkin',
    message:
      `I've updated ${done} record${done === 1 ? '' : 's'} so far and there ${remaining === 1 ? 'is' : 'are'} ` +
      `${remaining} left. Want me to keep going?`,
    resumable: true,
  };
}

/**
 * The loop's single guard call, so the order of checks lives in one place.
 *
 * Order matters and is deliberate: the bug guards come FIRST. A runaway that is
 * also touching many records must report the runaway, not offer to continue —
 * asking "keep going?" about a loop invites the user to authorise more of it.
 */
export function checkCeilings(state: {
  toolCallsThisTurn: number;
  turnsThisRun: number;
  bulk?: { done: number; remaining: number };
  /**
   * #363 — a workspace build raises these. Overrides rather than a second set of
   * constants, so there is still exactly ONE place that decides what a ceiling
   * MEANS and what it says when hit.
   */
  maxToolCalls?: number;
  maxTurns?: number;
}): CeilingStop | null {
  return (
    checkTurnCeiling(state.turnsThisRun, state.maxTurns) ??
    checkToolCallCeiling(state.toolCallsThisTurn, state.maxToolCalls) ??
    (state.bulk ? checkBulkCheckin(state.bulk.done, state.bulk.remaining) : null)
  );
}
