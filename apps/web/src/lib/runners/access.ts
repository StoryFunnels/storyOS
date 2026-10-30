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
