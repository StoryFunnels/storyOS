import type { AgentView } from './agents';
import type { WakeDto } from './types';
import { clockTime, shortDate } from './words';
import type { TimeOpts } from './words';

/**
 * Ticket #1196 — the columns of AI › Agents that need a rule: Job, Last run, Manager (and the Runs on words). Pure, so each rule
 * has a test; the page only draws what these return.
 */

/** The run states that mean a run EXISTS (it started, or finished): not "waiting for a Runner", not cancelled. */
const RAN_STATES = new Set(['done', 'failed', 'running', 'needs_approval', 'waiting_for_limit', 'waiting_for_hours', 'waiting_for_reserve']);

export type LastRun = { kind: 'at'; iso: string; state: string } | { kind: 'ranUnknown' } | { kind: 'never' } | { kind: 'unknown' };

type WakeLike = Pick<WakeDto, 'finished_at' | 'created_at' | 'run_state'> & { agent: { id: string } };

/**
 * What the Runs database told us, read in two calls that do not grow with the number of agents:
 *  - `counts`: runs per agent, from the grouped count (exact: an agent with no group has NO Run record, which is how "never" is KNOWN);
 *  - `latest`: the newest Run records by start time, one bounded page (`started` is the Run's "Started at").
 * `undefined` for the whole thing means the viewer cannot read the Runs database (a guest), or it has not loaded, or a call failed:
 * then nothing about "never" is known.
 */
export interface RunsKnowledge {
  counts: Record<string, number>;
  latest: ReadonlyArray<{ agentId: string; started: string }>;
}

/**
 * Every agent's last run. The rule that matters is when the answer is "Never": ONLY when it is KNOWN, because a confident zero
 * invites no checking (CLAUDE.md, Tyron: "never guess numbers, zero most of all"). So:
 *  - the newest Run record of the agent that the latest page holds -> that time (the Run records are the source of truth: unlike
 *    the wake queue they are not pruned after 30 days, and the viewer reads them the way they read the Runs database);
 *  - the wake queue's `run_state` only ADDS what a Run record cannot say at a glance: a run waiting for approval, at its limit,
 *    running or failed shows with that state, and its time wins when it is newer (or when the Run record has no time);
 *  - the agent has Run records but none in the latest page -> it DID run and when is unknown: `ranUnknown`, shown "—";
 *  - the agent has NO Run record (the grouped count is exact and has no group for it) and no wake shows a run -> `never`;
 *  - the Runs database was not readable / not loaded -> `unknown` ("—"), whatever the wake queue says or lacks. An agent's
 *    only run may be on a record the viewer cannot read, or its wakes may have been pruned: neither is evidence of "never".
 */
export function lastRunsByAgent(agentIds: readonly string[], wakes: readonly WakeLike[] | undefined, runs: RunsKnowledge | undefined): Record<string, LastRun> {
  const fromWake = new Map<string, Extract<LastRun, { kind: 'at' }>>();
  for (const w of wakes ?? []) {
    const state = w.run_state?.state;
    if (!state || !RAN_STATES.has(state)) continue;
    const iso = w.finished_at ?? w.run_state.since ?? w.created_at;
    const prev = fromWake.get(w.agent.id);
    if (!prev || new Date(iso) > new Date(prev.iso)) fromWake.set(w.agent.id, { kind: 'at', iso, state });
  }
  const fromRuns = new Map<string, string>();
  for (const r of runs?.latest ?? []) {
    const prev = fromRuns.get(r.agentId);
    if (!prev || new Date(r.started) > new Date(prev)) fromRuns.set(r.agentId, r.started);
  }
  const out: Record<string, LastRun> = {};
  for (const id of agentIds) {
    const wake = fromWake.get(id);
    const started = fromRuns.get(id);
    if (wake && (!started || new Date(wake.iso) >= new Date(started))) out[id] = wake;
    else if (started) out[id] = { kind: 'at', iso: started, state: 'done' };
    else if (!runs) out[id] = { kind: 'unknown' };
    else out[id] = (runs.counts[id] ?? 0) > 0 ? { kind: 'ranUnknown' } : { kind: 'never' };
  }
  return out;
}

/** The words under the time for a run that is not simply done. Empty for done (the time says it). */
export function lastRunState(last: LastRun): string {
  if (last.kind !== 'at') return '';
  return (
    { failed: 'Failed', running: 'Running', needs_approval: 'Needs approval', waiting_for_limit: 'Waiting for limit', waiting_for_hours: 'Waiting for hours', waiting_for_reserve: 'Waiting for reserve' } as Record<string, string>
  )[last.state] ?? '';
}

/** "Never", "18:40" for today, "29 Oct" earlier this year, "29 Oct 2025" in another year. "—" when it could not be read. */
export function lastRunLabel(last: LastRun, now: Date, o: TimeOpts = {}): string {
  if (last.kind === 'never') return 'Never';
  if (last.kind === 'unknown' || last.kind === 'ranUnknown') return '—';
  const when = new Date(last.iso);
  if (shortDate(when, o) === shortDate(now, o)) return clockTime(when, o);
  const year = (d: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: o.timeZone }).format(d);
  return year(when) === year(now) ? shortDate(when, o) : `${shortDate(when, o)} ${year(when)}`;
}

/** The full date and time, in the viewer's zone, for the tooltip ("29 Oct 2026, 18:40"). Absent when there is no time to show. */
export function lastRunTitle(last: LastRun, o: TimeOpts = {}): string | undefined {
  if (last.kind === 'ranUnknown') return 'It has run, but when is not shown here yet';
  if (last.kind === 'unknown') return 'Not shown: this screen cannot read the run history';
  if (last.kind !== 'at') return undefined;
  const when = new Date(last.iso);
  const state = lastRunState(last);
  const full = `${shortDate(when, o)} ${new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: o.timeZone }).format(when)}, ${clockTime(when, o)}`;
  return state ? `${state} · ${full}` : full;
}

/** "Ievgen Krasovytskyi" -> "Ievgen K." (the prototype's own form). One word stays one word. */
export function shortPersonName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

export interface DirectoryRow {
  title: string;
  values: Record<string, unknown>;
}

/**
 * The Manager cell: the agent's owner (ADR-0021 Q2). Current members first. A person who LEFT is not in the people list but is
 * TOMBSTONED in the Members database (`active` = false, ADR-0017 section 7), so their name still resolves and carries a "left"
 * marker. Only an owner found in neither (or data not loaded yet) is "—": never a guess.
 */
export function managerLabel(
  agent: Pick<AgentView, 'ownerId'>,
  members: ReadonlyArray<{ user: { id: string; name: string } }> | undefined,
  directory?: readonly DirectoryRow[],
): string {
  const m = members?.find((x) => x.user.id === agent.ownerId);
  if (m) return shortPersonName(m.user.name);
  const row = agent.ownerId ? directory?.find((r) => r.values['user_id'] === agent.ownerId) : undefined;
  if (!row) return '—';
  return row.values['active'] === false ? `${shortPersonName(row.title)} (left)` : shortPersonName(row.title);
}

/** Whether any listed agent's owner is missing from the people list, which is the only time the Members directory is read. */
export function needsDirectory(agents: ReadonlyArray<Pick<AgentView, 'ownerId'>>, members: ReadonlyArray<{ user: { id: string } }> | undefined): boolean {
  if (!members) return false;
  return agents.some((a) => a.ownerId && !members.some((m) => m.user.id === a.ownerId));
}

/** The "Runs on" cell. A guest is never told the machine (`showMachine`); an agent that does not use a Runner says what it uses instead. */
export function runsOnCell(agent: Pick<AgentView, 'usesRunner' | 'enabled' | 'aiMode'>, runner: { name: string } | null | undefined, showMachine: boolean): string {
  if (!agent.usesRunner) {
    if (!agent.enabled) return 'Switched off';
    return agent.aiMode === 'StoryOS AI' ? 'StoryOS AI' : 'Without an AI';
  }
  if (!runner) return 'No Runner yet';
  return showMachine ? runner.name : 'A Runner';
}

/** "1 agent." / "3 agents." */
export function agentCountLine(n: number): string {
  return `${n} ${n === 1 ? 'agent' : 'agents'}. Hired agents come with packs or from Hire an agent.`;
}
