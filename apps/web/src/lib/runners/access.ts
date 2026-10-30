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
