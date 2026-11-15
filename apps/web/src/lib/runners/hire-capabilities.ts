/**
 * Ticket #1196 — what the API accepts TODAY, as ONE named check, so that no control on the hire card offers something the API
 * refuses ("no dead options") and each one switches on by flipping a single line when its API lands.
 *
 *  - `scheduleCadence`: every N minutes (10-minute floor), weekdays Mon-Fri, an "only between" window and the time zone a
 *    schedule is read in. Ticket #1194, merged (PR #1391). `packages/schemas/src/schedule.ts` is the contract.
 *  - `wholeSpaceTargets`: an agent working in a WHOLE SPACE, including databases added to it later. Ticket #1195, merged (PR #1442):
 *    the agent's record has a `target_spaces` text field (space ids or names, comma-separated) next to `target_databases`, and
 *    `GET /agents/{agent}/scope` resolves a space to its databases at call time. The field is back-filled by `POST /agents/ensure`
 *    (admin-only), so a workspace whose Agents database predates it offers the space row only to someone who can ensure it (see
 *    `holdsSpaceTargets`): the card never offers a row the API would refuse.
 */
export type HireCapability = 'scheduleCadence' | 'wholeSpaceTargets';

export type Caps = Readonly<Record<HireCapability, boolean>>;

export const HIRE_API_CAPABILITIES: Caps = {
  scheduleCadence: true, // ticket #1194 (PR #1391) is on main
  wholeSpaceTargets: true, // ticket #1195 (PR #1442) is on main; its payload is `target_spaces` in `hireRecordValues`
};

export function apiAccepts(capability: HireCapability, caps: Caps = HIRE_API_CAPABILITIES): boolean {
  return caps[capability];
}
