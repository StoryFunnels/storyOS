import { atLeast } from '@/lib/access';
import type { EffectiveRole } from '@/lib/access';

/**
 * Ticket #1139 — who may open the Runner screens. A Runner is a person's own computer and subscription: members and admins hold
 * them, a guest never does (the API refuses every Runner call for a guest, #1091's rule, `GUEST_RUNNER_MESSAGE`). `undefined`
 * (the role has not loaded) is "not yet", never "allowed": the page waits rather than flashing a screen it then has to retract.
 */
export function canUseRunners(role: string | undefined): boolean {
  return role === 'admin' || role === 'member';
}

/** The API's own sentence (`GUEST_RUNNER_MESSAGE` in runners.service.ts), so the page and the refusal say the same thing. */
export const GUEST_RUNNERS_MESSAGE = 'Guests cannot pair a Runner. Ask a workspace admin if you need access.';

/**
 * Whether the viewer may be TOLD which machine and tool an agent runs on, and may hire. One predicate for every Runner surface
 * (agent page, Agents page, run rows, Runs-on line, Hire button) so a guest who holds a grant on the Agents database, and can
 * therefore read `agent-wakes/summary` (it carries the Runner's machine name), is not shown a colleague's computer. The server
 * also refuses a guest's hire (403); this stops the screen offering what is refused. Same rule as `canUseRunners`, named for what
 * it gates.
 */
export const canSeeRunnerDetails = canUseRunners;
export const canHireAgents = canUseRunners;

/**
 * Ticket #1210 — who is offered "Let it think with your AI". The agent's MANAGER (its owner, ADR-0021 Q2) or an admin, and only
 * when the write the action makes would be accepted: it edits the agent's record, which needs at least `contributor` on the Agents
 * database (the server's own bar). A guest never sees it, whatever grant they hold: this is a Runner surface. `myAccess`
 * `undefined` (the database has not loaded) is "not yet", never "allowed".
 */
export function canLetAgentThink(o: { role: string | undefined; isOwner: boolean; myAccess: EffectiveRole | undefined | null }): boolean {
  if (!canUseRunners(o.role)) return false;
  if (!(o.isOwner || o.role === 'admin')) return false;  return atLeast(o.myAccess ?? undefined, 'contributor');
}

/**
 * Ticket #1210 — who may press "Run now". `POST /workspaces/{ws}/agents/{agent}/run` is admin-only (the Agents controller is
 * `@MinRole('admin')`), so this is the admin role and nothing wider; widening it needs the API to move first.
 */
export function canRunAgentNow(role: string | undefined): boolean {
  return role === 'admin';
}
