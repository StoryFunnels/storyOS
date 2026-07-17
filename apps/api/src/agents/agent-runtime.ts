import type { AgentPrincipal } from './agent-principal';

/**
 * The runtime seam (#205, ADR-0010 §3).
 *
 * The engine depends on this interface, never on a specific model. That is what
 * lets manual and non-AI runs ship — and be dogfooded — before any managed
 * runtime exists, and it is where the BYO-AI promise (MN-188) is made
 * structural rather than a billing rule bolted on later.
 */

/** One tool call in a run's step log. */
export interface AgentStep {
  tool: string;
  summary: string;
  detail?: string;
}

/**
 * How a run is driven — and therefore whether it is metered.
 *
 *   non_ai       — deterministic automation, no model. Never metered.
 *   your_own_ai  — the user's model drives the tools over MCP. NEVER metered,
 *                  by construction (MN-188: "use your own AI, zero markup").
 *   storyos_ai   — StoryOS's managed model. Metered; decrements prepaid credits.
 */
export type RunClass = 'non_ai' | 'your_own_ai' | 'storyos_ai';

/** The Run-record "Run class" select label for each class (the stamp at dispatch). */
export const RUN_CLASS_LABEL: Record<RunClass, string> = {
  non_ai: 'Non-AI',
  your_own_ai: 'Your own AI',
  storyos_ai: 'StoryOS AI',
};

/** The agent definition a runtime needs — read off the agent record. */
export interface AgentRunAgent {
  id: string;
  name: string;
  goal?: string;
  instructions?: string;
  scopes: string[];
  targetDatabases?: string;
}

export interface AgentRunContext {
  workspaceId: string;
  agent: AgentRunAgent;
  principal: AgentPrincipal;
  /** The record that triggered the run, for state-change runs (#215, later). */
  inputRecordId?: string;
}

/**
 * A driver for agent execution. `runClass` is a property of the *runtime*, not
 * of any individual step — which is exactly what lets dispatch classify a run
 * before executing anything (see pickRuntime).
 */
export interface AgentRuntime {
  readonly runClass: RunClass;
  execute(ctx: AgentRunContext): AsyncIterable<AgentStep>;
}

/**
 * The default runtime: executes with NO LLM (ADR-0010 §3).
 *
 * It yields a deterministic account of what the run resolved to — the principal
 * it would act as, the databases it may touch, and the fact that tool-driving
 * itself is the BYO-AI client's job over MCP. That makes a manual run genuinely
 * useful (it is a real, inspectable, least-privilege dry run) before either the
 * managed runtime or the state dispatcher exists.
 */
export class NonAiRuntime implements AgentRuntime {
  readonly runClass: RunClass = 'non_ai';

  async *execute(ctx: AgentRunContext): AsyncIterable<AgentStep> {
    yield {
      tool: 'principal.resolve',
      summary: `Resolved principal — acting as the owner with \`${ctx.principal.scope}\` scope`,
      detail:
        `Declared scopes: ${ctx.agent.scopes.length ? ctx.agent.scopes.join(', ') : '(none — defaulted to read)'}. ` +
        `The effective scope is capped at the owner's own (ADR-0010 §2), so this run can never ` +
        `exceed what its owner could do by hand.`,
    };

    const targets = ctx.agent.targetDatabases?.trim();
    yield {
      tool: 'targets.resolve',
      summary: targets ? `Target databases: ${targets}` : 'No target databases configured',
      detail: targets
        ? undefined
        : 'Set "Target databases" on the agent record to scope which data it may act on.',
    };

    yield {
      tool: 'runtime.note',
      summary: 'Non-AI run — no model was invoked, so nothing was metered',
      detail:
        'This runtime performs no LLM calls. With BYO-AI, your own model drives this agent\'s ' +
        'tools over MCP and is never metered by StoryOS (MN-188). A managed runtime is the ' +
        'seam behind ManagedAiRuntime.',
    };
  }
}

/**
 * The seam for StoryOS's managed model (metered, decrements prepaid credits,
 * records `cost`). Not configured yet — it throws rather than silently
 * degrading to the non-AI path, which would misreport what a run actually did.
 */
export class ManagedAiRuntime implements AgentRuntime {
  readonly runClass: RunClass = 'storyos_ai';

  // eslint-disable-next-line require-yield
  async *execute(_ctx: AgentRunContext): AsyncIterable<AgentStep> {
    throw new Error('Managed AI runtime not configured');
  }
}

/**
 * Choose the runtime for an agent — and therefore its run class.
 *
 * CRITICAL (ADR-0010 §3): this is called at **dispatch, before any step
 * executes**, and its `runClass` is stamped on the Run record up front. A
 * your-own-AI run is therefore provably never metered — classification cannot
 * drift as a consequence of what the run happens to do.
 *
 * Today every agent gets the non-AI runtime; selecting the BYO-AI/managed
 * drivers arrives with the runtimes themselves.
 */
export function pickRuntime(_agent: AgentRunAgent): AgentRuntime {
  return new NonAiRuntime();
}

/** The step log, rendered as the markdown list stored in the Run's `Steps`. */
export function stepsToMarkdown(steps: AgentStep[]): string {
  return steps
    .map((s) => `- **${s.tool}** — ${s.summary}${s.detail ? `\n  - ${s.detail}` : ''}`)
    .join('\n');
}
