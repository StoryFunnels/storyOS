import type { AgentView } from './agents';
import type { WakeDto } from './types';
import { clockTime, shortDate } from './words';
import type { TimeOpts } from './words';

/**
 * Ticket #1196 — the columns of AI › Agents that need a rule: Job, Last run, Manager (and the Runs on words). Pure, so each rule
 * has a test; the page only draws what these return.
 */

export type LastRun = { kind: 'at'; iso: string } | { kind: 'never' } | { kind: 'unknown' };

/**
 * An agent's last run: the newest wake that FINISHED (done or failed; a queued or cancelled wake did not run). `wakes` is one page
 * of the queue, newest first. When the page holds no finished wake AND there are older pages, "never" would be a guess about a
 * page we did not read, so it is `unknown` and the cell says so: unresolvable must never read as "never ran".
 */
export function lastRunOf(wakes: readonly Pick<WakeDto, 'status' | 'finished_at'>[] | undefined, hasMore: boolean): LastRun {
  if (!wakes) return { kind: 'unknown' };
  const times = wakes.filter((w) => (w.status === 'done' || w.status === 'failed') && w.finished_at).map((w) => w.finished_at as string);
  if (times.length > 0) return { kind: 'at', iso: times.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b)) };
  return hasMore ? { kind: 'unknown' } : { kind: 'never' };
}

/** "Never", "18:40" for today, "29 Oct" before. "—" when it could not be read. */
export function lastRunLabel(last: LastRun, now: Date, o: TimeOpts = {}): string {
  if (last.kind === 'never') return 'Never';
  if (last.kind === 'unknown') return '—';
  const when = new Date(last.iso);
  const sameDay = shortDate(when, o) === shortDate(now, o);
  return sameDay ? clockTime(when, o) : shortDate(when, o);
}

/** "Ievgen Krasovytskyi" -> "Ievgen K." (the prototype's own form). One word stays one word. */
export function shortPersonName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

/**
 * The Manager cell: the agent's owner (ADR-0021 Q2). A member list that has not loaded, or an owner not on it, is "—": never a guess.
 */
export function managerLabel(agent: Pick<AgentView, 'ownerId'>, members: ReadonlyArray<{ user: { id: string; name: string } }> | undefined): string {
  const m = members?.find((x) => x.user.id === agent.ownerId);
  return m ? shortPersonName(m.user.name) : '—';
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
