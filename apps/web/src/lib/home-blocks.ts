/**
 * Ticket #1274 — which blocks the workspace home shows, decided in one place.
 *
 * The rule (the ruling recorded on the ticket): home never hides what is waiting on the person.
 *  - REVIEW (approvals waiting) always shows, from day one, onboarding or not. It is no longer behind an
 *    "established workspace" gate; the getting-started card may sit above it but never replaces it.
 *  - AUTOMATION RUNS shows once the workspace has at least one agent. "Has an agent" comes from the real Agents
 *    data. A workspace with no Agents database, or an empty one, has no runs block and that is not an error.
 *  - A figure that is not known is not a figure: while loading or after a failed load, the count is `unknown`
 *    (the page draws a dash), never zero. A confident "nothing is waiting" about an approvals list that did not
 *    load is the worst thing this page can say.
 */

export interface AgentsKnowledge {
  loading: boolean;
  error: boolean;
  agentCount: number;
}

/** Show the Automation runs block only when we KNOW at least one agent exists. Unknown hides it (it never claims). */
export function showAutomationRuns(a: AgentsKnowledge): boolean {
  return !a.loading && !a.error && a.agentCount > 0;
}

export type ReviewState = { kind: 'unknown' } | { kind: 'none' } | { kind: 'some'; count: number };

export function reviewState(q: { isPending: boolean; isError: boolean; data: ReadonlyArray<unknown> | undefined }): ReviewState {
  if (q.isPending || q.isError || !q.data) return { kind: 'unknown' };
  return q.data.length === 0 ? { kind: 'none' } : { kind: 'some', count: q.data.length };
}

/** "Review" alone while unknown or empty; "Review · 3" when something waits. A dash for unknown is drawn by the caller. */
export function reviewTitle(s: ReviewState): string {
  return s.kind === 'some' ? `Review · ${s.count}` : 'Review';
}
