import { offlineSince, runnerConnection } from './runner-present';
import type { RunnerRow } from './runner-present';
import type { WakeStatus } from './wake.constants';

/**
 * ONE server-derived field for "what is this agent doing about this" (ADR-0021 §11). The web and MCP render it and never recompute
 * it. Dara's states, plus `failed` and `canceled`, which she did not draw and which exist.
 */
export type RunStateName =
  | 'needs_approval'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'waiting_for_runner'
  | 'runner_offline'
  | 'waiting_for_limit'
  | 'waiting_for_turn';

export interface RunState {
  state: RunStateName;
  /** An instant (ISO). The client formats it in the viewer's timezone. */
  since?: string;
  until?: string;
  runner_name?: string;
  tool?: string;
}

export interface RunStateInput {
  wakeStatus: WakeStatus;
  claimedAt: Date | null;
  /** The Run record's status label ('Queued', 'Running', 'Waiting approval', 'Succeeded', 'Failed', 'Canceled'), or null when unknown. */
  runStatus: string | null;
  /** The Runner this agent is assigned to (or the one holding the claim). */
  runner: RunnerRow | null;
  /** The agent, or its Runner, already has a claimed wake ("one job at a time"). */
  agentBusy: boolean;
  /** The wake's own `not_before`: a run stopped by the subscription limit may not be claimed before it (ticket #1133). */
  notBefore?: Date | null;
  now: Date;
}

/** First match wins, in the order the ADR lists. A pure function: nothing here reads the database. */
export function deriveRunState(i: RunStateInput): RunState {
  if (i.runStatus === 'Waiting approval') return { state: 'needs_approval' };
  if (i.wakeStatus === 'claimed') {
    return { state: 'running', ...(i.runner ? { runner_name: i.runner.name } : {}), ...(i.claimedAt ? { since: i.claimedAt.toISOString() } : {}) };
  }
  if (i.wakeStatus === 'done' || i.runStatus === 'Succeeded') return { state: 'done' };
  if (i.wakeStatus === 'failed' || i.runStatus === 'Failed') return { state: 'failed' };
  if (i.wakeStatus === 'canceled' || i.runStatus === 'Canceled') return { state: 'canceled' };

  // A queued wake: why it is not running yet, in the ADR's order.
  const r = i.runner;
  if (!r || r.status !== 'active') return { state: 'waiting_for_runner' };
  if (runnerConnection(r, i.now) === 'offline') {
    const since = offlineSince(r, i.now);
    return { state: 'runner_offline', ...(since ? { since: since.toISOString() } : {}), runner_name: r.name };
  }
  // The Runner's pause is the live source (ADR-0021 §11). A wake also holds its OWN time (`not_before`, set when the tool hit its
  // limit): if that is later than the Runner's pause (the pause was cleared, or a shorter limit from another run did not extend it)
  // the wake still cannot be claimed before it, so it still reads "waiting for the limit", until the LATER of the two.
  const pausedMs = r.pausedUntil && r.pausedUntil.getTime() > i.now.getTime() ? r.pausedUntil.getTime() : 0;
  const heldMs = i.notBefore && i.notBefore.getTime() > i.now.getTime() ? i.notBefore.getTime() : 0;
  if (pausedMs || heldMs) {
    return { state: 'waiting_for_limit', until: new Date(Math.max(pausedMs, heldMs)).toISOString(), ...(r.chosenTool ? { tool: r.chosenTool } : {}), runner_name: r.name };
  }
  if (i.agentBusy) return { state: 'waiting_for_turn', runner_name: r.name };
  return { state: 'waiting_for_runner', runner_name: r.name };
}
