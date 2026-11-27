import { catchUpCount } from './catch-up';
import { queuedRunsLine, recordsWaitingCount } from './runner-state';
import type { WakeSummaryAgent, WakeVisibility } from './types';

/**
 * Ticket #1276 (the web half of #1228) — what an agent's activity says when the API tells this viewer some of it is hidden.
 *
 * The server decides (`visibility` on the wakes list and the summary, `waiting_visibility` per agent). The page's job is to never
 * turn a hidden part into a number or into "nothing": a guest whose agent works somewhere they cannot read would otherwise be shown
 * "0 finished so far" and a Quill saying "Yes, chef", both false. A field an older API does not send reads as 'full'.
 */
export function isLimited(visibility: WakeVisibility | string | null | undefined): boolean {
  return visibility === 'limited';
}

export const RUNS_HIDDEN_HEADER = 'Some runs are hidden from you';

/** The empty list for a viewer who can see none of the runs: not "No runs yet", which would say there are none. */
export function limitedEmptyTitle(agentName: string): string {
  return `You can't see ${agentName}'s activity`;
}

export function limitedEmptyBody(agentName: string): string {
  return `${agentName} works in places your access doesn't cover. Its runs there are hidden from you, and so is how many there are.`;
}

/** Where the page would say "N runs are queued for it" and the queue is partly hidden. */
export const QUEUE_HIDDEN = 'Hidden from you';

/**
 * Ticket #1276 — every waiting-related fact the agent page may state for one agent, decided in ONE place so the page cannot show a
 * count on one line and hide it on the next. When the queue is partly hidden from the viewer (`waiting_visibility: 'limited'`) there
 * is no queued-run line, no records-waiting count and no catch-up count: each is null, and `hidden` says to say so instead.
 */
export function waitingFacts(row: Pick<WakeSummaryAgent, 'waiting' | 'waiting_visibility' | 'catch_up'> | undefined): {
  hidden: boolean;
  catchUp: number | null;
  recordsWaiting: number | null;
  queued: string | null;
} {
  if (isLimited(row?.waiting_visibility)) return { hidden: true, catchUp: null, recordsWaiting: null, queued: null };
  return {
    hidden: false,
    catchUp: catchUpCount(row),
    recordsWaiting: recordsWaitingCount(row),
    queued: row && row.waiting > 0 ? queuedRunsLine(row.waiting) : null,
  };
}
