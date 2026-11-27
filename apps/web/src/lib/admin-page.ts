/**
 * Ticket #1391 — the few decisions /admin makes about what to show, kept out of the page so they can be tested in plain node.
 */

/** What a run record says about itself beyond its title. A run with none of these has nothing to report. */
export interface RunDetails {
  agent: unknown;
  status: string | null;
  runClass: string | null;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** True when the run records anything at all besides its title and workspace. */
export function hasRunDetails(run: RunDetails): boolean {
  return Boolean(run.agent) || run.status !== null || run.runClass !== null || run.trigger !== null || run.startedAt !== null || run.finishedAt !== null;
}

/**
 * Splits the Runs list into the rows worth a line and the count of empty ones (a record in a Runs database that nothing ever filled in).
 * The count is returned rather than dropped so the page can say how many it left out: a hidden row is never silent.
 * A run that knows only SOME of its details stays in the list and shows what it has.
 */
export function splitEmptyRuns<T extends RunDetails>(runs: T[]): { shown: T[]; emptyCount: number } {
  const shown = runs.filter(hasRunDetails);
  return { shown, emptyCount: runs.length - shown.length };
}

/** An audit-trail actor as the API returns it: the person, or null when their account no longer exists. */
export interface AuditActor {
  actorUserId: string;
  actor: { name: string; email: string } | null;
}

/** The name and email to print for an audit-trail row; a deleted account is called that rather than shown as an opaque id. */
export function auditActorLabel(row: AuditActor): { name: string; email: string | null } {
  if (row.actor) return { name: row.actor.name, email: row.actor.email };
  return { name: 'Deleted user', email: null };
}

/** The AI (est.) column exists for the day StoryOS pays for AI itself; while every workspace's figure is zero it carries nothing. */
export function showAiCostColumn(workspaces: Array<{ aiCostCents: number }>): boolean {
  return workspaces.some((w) => w.aiCostCents !== 0);
}
