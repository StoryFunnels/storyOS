import type { WakeSummary, WakeSummaryAgent } from './types';

/**
 * Ticket #1223 — what the agent page may SAY about an agent's Runner.
 *
 * "Which Runner serves this agent" is only known once `GET /agent-wakes/summary` has answered. Until then (and if it fails) the
 * page does not know, and "No Runner yet" is a statement of fact about a state it has not read: a loading or failed summary
 * for an agent that HAS a Runner printed exactly that. So the state has four values, and only a LOADED summary with no
 * assignment may say "none".
 */
export type RunnerLineState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'assigned'; runner: { id: string | null; name: string } }
  | { kind: 'none' };

/** What this needs of the summary query: its data (kept across a failed background refetch) and whether it errored. */
export interface SummaryLike {
  data: WakeSummary | undefined;
  isError: boolean;
}

export const RUNNER_LOAD_FAILED = "Couldn't load this agent's Runner. Try again.";

export function runnerLineState(summary: SummaryLike, agentId: string): RunnerLineState {
  // A summary we already hold stays true through a failed refresh; only the absence of one is "unknown".
  if (!summary.data) return summary.isError ? { kind: 'failed' } : { kind: 'loading' };
  const runner = summary.data.agents.find((a: WakeSummaryAgent) => a.agent_id === agentId)?.runner ?? null;
  return runner ? { kind: 'assigned', runner } : { kind: 'none' };
}

/**
 * The records ALREADY in the agent's trigger state, for the no-Runner page: the summary's own `catch_up` (ticket #1152), or null
 * when it is not known. `null` and `0` both print nothing: not told is not zero, and zero is nothing to say. It is NOT
 * `waiting`, which counts queued wakes (a different set: a record can have been woken twice, or never).
 */
export function recordsWaitingCount(row: Pick<WakeSummaryAgent, 'catch_up'> | undefined): number | null {
  const n = row?.catch_up;
  return typeof n === 'number' && n > 0 ? n : null;
}

/** "1 record is waiting for it" / "4 records are waiting for it". Only ever fed a real `catch_up`. */
export function recordsWaitingLine(n: number): string {
  return n === 1 ? '1 record is waiting for it' : `${n} records are waiting for it`;
}

/** Queued wakes are runs in line, not records: "1 run is queued for it" / "3 runs are queued for it". Never worded as records. */
export function queuedRunsLine(n: number): string {
  return n === 1 ? '1 run is queued for it' : `${n} runs are queued for it`;
}
