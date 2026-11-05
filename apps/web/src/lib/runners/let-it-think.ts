import type { AgentView, FieldWithOptions } from './agents';
import type { RunnerDto, WakeDto } from './types';

/**
 * Ticket #1210 — "Let it think with your AI": moving an agent from Non-AI to Your own AI from its own page, and "Run now".
 *
 * Before this, the only way to change an agent's AI mode was to edit the AI mode field in Agentic OS › Agents, so an agent
 * installed as Non-AI (every pack installed before ticket #1106 did) said "needs no Runner" with no way forward. Pure, so each
 * rule has a test that fails when the rule is broken.
 */

/** The two modes this page moves an agent between. The labels are the Agents database's own option labels. */
export const OWN_AI = 'Your own AI';
export const NON_AI = 'Non-AI';

/**
 * Whether the page offers the action at all: an ENABLED agent that runs its steps without an AI. An unset mode counts as Non-AI
 * (the runtime treats it so, and today's copy says "without an AI" for it too): unconfigured is not invalid. A switched-off agent
 * is not offered it (the page says "Switched off", and a mode change would not make it run), and a StoryOS AI agent already thinks.
 */
export function offersLetItThink(agent: Pick<AgentView, 'enabled' | 'aiMode'>): boolean {
  return agent.enabled && (agent.aiMode === 'Non-AI' || agent.aiMode === null);
}

/**
 * Whether Advanced offers "Run without an AI": an agent that currently thinks with the person's own AI and is enabled (a switched-off
 * agent shows no Advanced at all). The gate on WHO is `canLetAgentThink`, the same one as the reverse switch.
 */
export function offersRunWithoutAi(agent: Pick<AgentView, 'enabled' | 'aiMode'>): boolean {
  return agent.enabled && agent.aiMode === 'Your own AI';
}

/** The option id the Agents database stores for a mode label, or null when this database has no such option (an older pack). */
export function aiModeOptionId(fields: readonly FieldWithOptions[], label: typeof OWN_AI | typeof NON_AI): string | null {
  return fields.find((f) => f.apiName === 'ai_mode')?.options?.find((o) => o.label === label)?.id ?? null;
}

/**
 * The Runner to preselect after the switch: the manager's ONLY online Runner. Zero online, or two, means the person chooses,
 * because guessing which computer an agent's prompts go through is not ours to do. `runners` is already the agent owner's own
 * active list (`ownerRunners`), so another person's machine cannot be picked here.
 */
export function soleOnlineRunner(runners: readonly RunnerDto[]): RunnerDto | null {
  const online = runners.filter((r) => r.status === 'active' && r.connection === 'online');
  return online.length === 1 ? online[0]! : null;
}

export interface LetItThinkResult {
  /** The Runner the agent was sent to, or null when none was preselected or choosing it failed. */
  runner: { id: string; name: string } | null;
  /** Set when the mode changed but the Runner could not be chosen: the mode is NOT rolled back, the person is told to pick one. */
  assignError: unknown;
}

/**
 * The switch, in the only order the API allows: the mode first (a Runner is refused for an agent that is not Your own AI), then
 * the preselected Runner. A failed mode write throws and nothing else happens. A failed Runner assignment does not undo the mode:
 * the agent is now Your own AI and its page shows "Runs on No Runner yet", which is true and which the person can fix with Change.
 */
export async function letItThink(
  deps: { setMode: (optionId: string) => Promise<unknown>; assign: (runnerId: string) => Promise<unknown> },
  ownAiOptionId: string,
  preselect: { id: string; name: string } | null,
): Promise<LetItThinkResult> {
  await deps.setMode(ownAiOptionId);
  if (!preselect) return { runner: null, assignError: null };
  try {
    await deps.assign(preselect.id);
    return { runner: preselect, assignError: null };
  } catch (e) {
    return { runner: null, assignError: e };
  }
}

/** What the toast says, from what actually happened. */
export function letItThinkToast(agentName: string, result: LetItThinkResult, runnersKnown: boolean): string {
  if (result.runner) return `${agentName} now thinks with your AI, on ${result.runner.name}.`;
  if (result.assignError) return `${agentName} now thinks with your AI, but a Runner could not be chosen. Use Change to pick one.`;
  return runnersKnown
    ? `${agentName} now thinks with your AI. Choose where it runs.`
    : `${agentName} now thinks with your AI. Its owner needs to choose where it runs.`;
}

// ---------- Run now ----------

/**
 * Whether the page offers "Run now": an agent a Runner serves (it is Your own AI, enabled, and has a Runner assigned), for someone
 * the API lets start it. The start endpoint (`POST .../agents/{agent}/run`) is admin-only, so the button is too: showing it to a
 * member would offer what the server refuses. The role is the access.ts predicate's.
 */
export function offersRunNow(agent: Pick<AgentView, 'usesRunner'>, assigned: { id: string } | null | undefined, mayRun: boolean): boolean {
  return mayRun && agent.usesRunner && Boolean(assigned);
}

/**
 * A manual wake for this agent that is already on its way (queued or claimed, made by hand, about no particular record). While
 * one is open the button says so and does nothing: the server coalesces a repeat into the same Run, but a button that looks
 * pressable and silently returns the old Run is a button that seems broken.
 */
export function openManualWake(wakes: readonly Pick<WakeDto, 'reason' | 'status' | 'record'>[]): boolean {
  return wakes.some((w) => w.reason === 'manual' && !w.record && (w.status === 'queued' || w.status === 'claimed'));
}

/** What the toast says after Run now, from whether a Runner can take it right now (the summary's own `can_run`). */
export function runNowToast(agentName: string, canRun: boolean, runnerName: string | null): string {
  return canRun
    ? `${agentName} is queued${runnerName ? ` for ${runnerName}` : ''}. It starts when the Runner picks it up.`
    : `${agentName} is queued, waiting for a Runner. It starts as soon as ${runnerName ?? 'its Runner'} is online.`;
}
