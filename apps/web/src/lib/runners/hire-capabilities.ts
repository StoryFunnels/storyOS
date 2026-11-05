/**
 * Ticket #1196 — what the API accepts TODAY, as ONE named check, so that no control on the hire card offers something the API
 * refuses ("no dead options") and each one switches on by flipping a single line when its API lands.
 *
 *  - `scheduleCadence`: every N minutes (10-minute floor), weekdays Mon-Fri, an "only between" window and the time zone a
 *    schedule is read in. Ticket #1194, merged (PR #1391). `packages/schemas/src/schedule.ts` is the contract.
 *  - `wholeSpaceTargets`: an agent working in a WHOLE SPACE, including databases added to it later. Ticket #1195, NOT merged: an
 *    agent's scope is still a list of databases (`target_databases`, one text field of database ids). Until it lands the picker
 *    lists databases only and the card never says "the whole space", because the screen must not promise what the API does not do.
 */
export type HireCapability = 'scheduleCadence' | 'wholeSpaceTargets';

export type Caps = Readonly<Record<HireCapability, boolean>>;

export const HIRE_API_CAPABILITIES: Caps = {
  scheduleCadence: true, // ticket #1194 (PR #1391) is on main
  wholeSpaceTargets: false, // ticket #1195 is ToDo: flip when it merges, then add its payload to `hireRecordValues`
};

export function apiAccepts(capability: HireCapability, caps: Caps = HIRE_API_CAPABILITIES): boolean {
  return caps[capability];
}
