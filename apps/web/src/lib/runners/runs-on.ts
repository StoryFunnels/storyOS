import type { RunnerDto } from './types';
import { COPY, toolName } from './words';

/**
 * Ticket #1139 AC3 — "Runs on <machine> · <tool> [Change]": who may change it, what the menu offers, and the rule that hiring is
 * never blocked by the lack of a Runner. Pure, so each rule has a test that fails when the rule is broken.
 *
 * ADR-0021 Q2: an agent reads records as its OWNER and its prompts pass through that person's machine and model account, so
 * the menu lists the agent OWNER's Runners and nobody else's. `GET .../runners` returns the CALLER's own Runners (admins
 * included, ADR-0018 (b): someone else's Runner is not revealed), so the owner's list is the caller's list if and only if the
 * caller IS the owner. For anyone else (an admin looking at a colleague's agent) the honest list is empty and the line is read-only.
 */
export function canChangeRunsOn(agentOwnerId: string | null | undefined, meId: string | null | undefined): boolean {
  return Boolean(agentOwnerId && meId && agentOwnerId === meId);
}

/** The Runners the menu may offer: the owner's own, active (a pending one is mid-pairing and cannot serve anything). */
export function ownerRunners(runners: readonly RunnerDto[], agentOwnerId: string | null | undefined, meId: string | null | undefined): RunnerDto[] {
  if (!canChangeRunsOn(agentOwnerId, meId)) return [];
  return runners.filter((r) => r.status === 'active');
}

export type RunsOnMenuItem =
  | { kind: 'runner'; runner: RunnerDto; selected: boolean }
  /** "Add a Runner…" is always last and always present: with no Runner it is the only item. */
  | { kind: 'add' };

/**
 * The menu: the owner's Runners with their live status, then "Add a Runner…". There is NO API-key item. Dara's design draws
 * one (dashed, marked LATER) and then says: hide it, an API key on StoryOS is not in v1 and returns with the workspace AI
 * connection (her comment on ticket #1139, ADR-0021 §11). A test pins that nothing here can produce it.
 */
export function buildRunsOnMenu(runners: readonly RunnerDto[], assignedRunnerId: string | null | undefined): RunsOnMenuItem[] {
  return [
    ...runners.map((runner): RunsOnMenuItem => ({ kind: 'runner', runner, selected: runner.id === assignedRunnerId })),
    { kind: 'add' },
  ];
}

export interface RunsOnLine {
  /** `none`: nothing assigned. `runner`: a machine and a tool. */
  kind: 'none' | 'runner';
  machine: string | null;
  tool: string | null;
  /** The viewer may not be told which machine: the line reads "Runs on a Runner". */
  masked: boolean;
}

/** "Ievgen's MacBook Pro · Claude Code", or "No Runner yet". The tool comes from the Runner's own chosen tool, not a default. */
export function runsOnLine(assigned: { id: string; name: string } | null | undefined, runners: readonly RunnerDto[], masked = false): RunsOnLine {
  if (!assigned) return { kind: 'none', machine: null, tool: null, masked: false };
  if (masked) return { kind: 'runner', machine: null, tool: null, masked: true };
  const r = runners.find((x) => x.id === assigned.id);
  return { kind: 'runner', machine: assigned.name, tool: r ? toolName(r.chosen_tool, r.tools) : null, masked: false };
}

export interface HireState {
  /** ALWAYS true. See below. */
  canHire: true;
  /** The sentence under the Runs-on line, or null when a Runner is already chosen. */
  note: string | null;
}

/**
 * "Hiring is never blocked" (Otto's AC, Dara's hire card): an agent can be hired before any Runner exists and simply waits.
 * The type says it too: `canHire` is the literal `true`, so a branch that returned false would not compile. What can still stop
 * the Hire button is the form (no name yet) and the API's own grants, neither of which is about a Runner.
 */
export function hireState(chosenRunner: { id: string } | null | undefined): HireState {
  return { canHire: true, note: chosenRunner ? null : COPY.hireNoRunner };
}
