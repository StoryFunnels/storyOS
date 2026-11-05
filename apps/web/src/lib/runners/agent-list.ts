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

export type LastRun = { kind: 'at'; iso: string; state: string } | { kind: 'never' } | { kind: 'unknown' };

type WakeLike = Pick<WakeDto, 'finished_at' | 'created_at' | 'run_state'> & { agent: { id: string } };

/**
 * Every agent's last run from ONE page of the workspace's wake queue (newest first), never one request per agent. Each wake's
 * `run_state` is the server's derivation from the Run record, so a run waiting for approval or for the limit shows with that state,
 * not only the ones that finished. The newest wake whose run exists wins; its time is when it finished, else when it began waiting.
 * An agent absent from the page is `unknown` when older pages exist (we did not read them: "Never" would be a guess) and `never`
 * only when the page was the whole queue.
 */
export function lastRunsByAgent(agentIds: readonly string[], wakes: readonly WakeLike[] | undefined, hasMore: boolean): Record<string, LastRun> {
  const out: Record<string, LastRun> = {};
  const best = new Map<string, LastRun>();
  for (const w of wakes ?? []) {
    const state = w.run_state?.state;
    if (!state || !RAN_STATES.has(state)) continue;
    const iso = w.finished_at ?? w.run_state.since ?? w.created_at;
    const prev = best.get(w.agent.id);
    if (!prev || (prev.kind === 'at' && new Date(iso) > new Date(prev.iso))) best.set(w.agent.id, { kind: 'at', iso, state });
  }
  for (const id of agentIds) out[id] = !wakes ? { kind: 'unknown' } : (best.get(id) ?? (hasMore ? { kind: 'unknown' } : { kind: 'never' }));
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
  if (last.kind === 'unknown') return '—';
  const when = new Date(last.iso);
  if (shortDate(when, o) === shortDate(now, o)) return clockTime(when, o);
  const year = (d: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: o.timeZone }).format(d);
  return year(when) === year(now) ? shortDate(when, o) : `${shortDate(when, o)} ${year(when)}`;
}

/** The full date and time, in the viewer's zone, for the tooltip ("29 Oct 2026, 18:40"). Absent when there is no time to show. */
export function lastRunTitle(last: LastRun, o: TimeOpts = {}): string | undefined {
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
