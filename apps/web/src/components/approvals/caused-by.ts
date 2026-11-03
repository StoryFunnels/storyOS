/**
 * Ticket #1193 (web half of ticket #1179) — who an Inbox row / approval card header names.
 *
 * The API's `caused_by` is the agent and run behind an approval an agent's run credential caused, already worded:
 * `{ agent_name, run_number, label: 'Sales assistant (run 42)', ... }`, or null when a person (or a rule) caused it. The
 * notification's `actor` is the rule author, which is the wrong name for an agent-caused approval, so the row and the card
 * header name the agent instead. ONE helper, because the slide-over, the full page's list row and its detail header all say
 * "who", and three copies of this ternary is how they would drift.
 *
 * Unconfigured is not invalid: every part of `caused_by` but the fact that it is present is optional. A missing `label`
 * is rebuilt from the agent name and run number; a missing name degrades to "An agent", never to blank.
 */
export interface CausedBy {
  agent_id?: string | null;
  agent_name?: string | null;
  run_id?: string | null;
  run_number?: number | null;
  runner_id?: string | null;
  runner_name?: string | null;
  label?: string | null;
}

export interface ActorLike {
  id: string;
  name: string;
  image: string | null;
}

export type Who =
  | { kind: 'agent'; name: string }
  | { kind: 'person'; name: string; actor: ActorLike }
  | { kind: 'other'; name: string };

const filled = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim() !== '';

/** The text naming the agent (and run) that caused an approval; never empty. */
export function causedByLabel(c: CausedBy): string {
  if (filled(c.label)) return c.label.trim();
  const name = filled(c.agent_name) ? c.agent_name.trim() : 'An agent';
  if (typeof c.run_number === 'number') return `${name} (run ${c.run_number})`;
  if (filled(c.run_id)) return `${name} (run ${c.run_id})`;
  return name;
}

/**
 * Who the row/header names: the agent when `caused_by` is present, else the notification's actor (a person), else — as before —
 * "Someone" when a record is behind it and "StoryOS" when nothing is (a bare notification: StoryOS did this, not a person, #263).
 */
export function notificationWho(n: { caused_by?: CausedBy | null; actor: ActorLike | null; record: unknown | null }): Who {
  if (n.caused_by) return { kind: 'agent', name: causedByLabel(n.caused_by) };
  if (n.actor) return { kind: 'person', name: n.actor.name, actor: n.actor };
  return { kind: 'other', name: n.record ? 'Someone' : 'StoryOS' };
}

/**
 * What a decision's response means for the toast. A repeat Approve/Reject answers 200 with `already_decided: true` and
 * changed nothing (the first decision enqueued the one job), so it must not read as a second success.
 */
export function decisionToast(verdict: 'approve' | 'reject', data: unknown): { kind: 'success' | 'info'; text: string } {
  const already = Boolean(data && typeof data === 'object' && (data as { already_decided?: unknown }).already_decided === true);
  if (already) return { kind: 'info', text: verdict === 'approve' ? 'Already approved' : 'Already rejected' };
  return { kind: 'success', text: verdict === 'approve' ? 'Approved' : 'Rejected' };
}

/** Routes a decision's outcome to the right toast: `success` only for a decision that changed something, `info` for a repeat. */
export function announceDecision(
  verdict: 'approve' | 'reject',
  data: unknown,
  toaster: { success: (text: string) => unknown; info: (text: string) => unknown },
): void {
  const t = decisionToast(verdict, data);
  if (t.kind === 'info') toaster.info(t.text);
  else toaster.success(t.text);
}
