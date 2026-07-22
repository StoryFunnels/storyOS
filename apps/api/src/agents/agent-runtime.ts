import { z } from 'zod';
import { actionSchema } from '@storyos/schemas';
import type { AgentPrincipal } from './agent-principal';

/**
 * The runtime seam (#205, ADR-0010 §3).
 *
 * The engine depends on this interface, never on a specific model. That is what
 * lets manual and non-AI runs ship — and be dogfooded — before any managed
 * runtime exists, and it is where the BYO-AI promise (MN-188) is made
 * structural rather than a billing rule bolted on later.
 */

/**
 * The action classes an owner can gate — the labels of the agent record's
 * "Approval policy" multi_select (ADR-0010 §4).
 *
 * This is the *policy* vocabulary: what a step would do, in the terms the owner
 * ticked a box in. It is deliberately not the executor's vocabulary — an
 * `outward` proposal and a `webhook` proposal can both apply through the same
 * `send_webhook` action, and the owner must be able to gate them apart.
 */
export const APPROVAL_POLICY_KINDS = [
  'delete',
  'webhook',
  'email',
  'run_button',
  'outward',
] as const;

/**
 * What a proposed step would do. The policy classes above, plus the ungated
 * everyday classes a runtime proposes — those simply execute inline unless the
 * owner has listed them.
 */
export type ProposedActionKind =
  | (typeof APPROVAL_POLICY_KINDS)[number]
  | 'set_values'
  | 'create_record'
  | 'add_comment'
  | 'notify_user'
  | 'update_linked';

/**
 * How a proposed action is *applied*, once (and only once) a gate passes.
 *
 * Everything reuses machinery that already exists: `automation_action` hands the
 * payload straight to the shared AutomationActionsService (MN-046/MN-047), and
 * `record_delete` goes through the records service's soft delete — which is what
 * keeps an applied destructive step undoable (ADR-0009, ADR-0010 §4).
 */
export const proposedActionPayloadSchema = z.discriminatedUnion('apply', [
  z.object({
    apply: z.literal('record_delete'),
    database_id: z.uuid(),
    record_id: z.uuid(),
  }),
  z.object({
    apply: z.literal('automation_action'),
    /** The database the action's context record lives in. */
    database_id: z.uuid(),
    /** The record the action runs against — ActionsService's `ctx.record`. */
    record_id: z.uuid(),
    action: actionSchema,
  }),
]);
export type ProposedActionPayload = z.infer<typeof proposedActionPayloadSchema>;

/**
 * An action a step wants to take, expressed as DATA rather than performed.
 *
 * ADR-0010 §4, the load-bearing idea of the whole trust layer: "propose the
 * action as data, apply it only on a gate pass." Approval, reject-with-no-side-
 * effects and undo all fall out of this one shape — a rejected action leaves no
 * trace because it was never anything but a value.
 *
 * `payload` is `unknown` on purpose. A proposal made by a runtime and a proposal
 * read back out of the Run record's `Pending action` JSON are the same thing to
 * the applier, so both go through `proposedActionPayloadSchema` at the one apply
 * boundary rather than being trusted at the type level.
 */
export interface ProposedAction {
  kind: ProposedActionKind;
  /** Shown verbatim to the owner in the Inbox — this IS the approval prompt. */
  summary: string;
  payload: unknown;
}

/** One tool call in a run's step log. */
export interface AgentStep {
  tool: string;
  summary: string;
  detail?: string;
  /**
   * Set when this step would DO something rather than just observe. If its kind
   * is in the agent's approval policy the run stages it and halts; otherwise it
   * applies inline and the run continues (ADR-0010 §4).
   */
  action?: ProposedAction;
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

/**
 * The reverse of RUN_CLASS_LABEL — an agent's own "AI mode" field stores the
 * same three labels (see AgentsService.ensurePack), and dispatch needs to turn
 * that label back into the RunClass pickRuntime switches on (#205 item 1).
 */
export const RUN_CLASS_BY_LABEL: Record<string, RunClass> = Object.fromEntries(
  (Object.entries(RUN_CLASS_LABEL) as Array<[RunClass, string]>).map(([runClass, label]) => [
    label,
    runClass,
  ]),
);

/** The agent definition a runtime needs — read off the agent record. */
export interface AgentRunAgent {
  id: string;
  name: string;
  goal?: string;
  instructions?: string;
  scopes: string[];
  targetDatabases?: string;
  /**
   * The agent's own "AI mode" field (#205 item 1) — what pickRuntime switches
   * on. Undefined (an unset field, or a workspace whose Agents database
   * predates this field) means exactly what it always has: non_ai.
   */
  aiMode?: RunClass;
}

export interface AgentRunContext {
  workspaceId: string;
  agent: AgentRunAgent;
  principal: AgentPrincipal;
  /** The record that triggered the run, for state-change runs (#215, later). */
  inputRecordId?: string;
  /**
   * Whether this workspace has a live API token — the "Connect your AI"
   * on-ramp (onboarding.controller.ts's `ai_connected`) that lets an external
   * MCP client actually reach this workspace. Only computed for a your_own_ai
   * dispatch (see AgentsService.dispatchRun) — every other runtime ignores it.
   */
  aiConnected?: boolean;
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
        "This runtime performs no LLM calls. With BYO-AI, your own model drives this agent's " +
        'tools over MCP and is never metered by StoryOS (MN-188). A managed runtime is the ' +
        'seam behind ManagedAiRuntime.',
    };
  }
}

/**
 * The BYO-AI/MCP driver (#205's genuinely remaining item 1).
 *
 * Selected the moment an agent's own "AI mode" field says `your_own_ai` —
 * before this, `pickRuntime` could never produce anything but NonAiRuntime, so
 * that option existed on the Run's `Run class` select and in RUN_CLASS_LABEL
 * but nothing in dispatch could ever actually stamp it in production (only
 * tests injected it directly via `runtimeFor`).
 *
 * It still makes NO model call — by construction, that absence is the entire
 * reason your-own-AI is unmetered (MN-188): the tool-driving loop runs
 * entirely in an external MCP client (Claude Desktop, ChatGPT connectors, or
 * any MCP-compatible client) that the workspace has connected with its own
 * API token, never in this process. What is real here, versus NonAiRuntime's
 * generic advisory, is that it checks the actual precondition that on-ramp
 * requires (`ctx.aiConnected` — a live workspace API token) and reports
 * honestly on which side of it the workspace is: either exactly what is
 * missing before an external AI can drive this agent at all, or the concrete
 * goal/instructions/scope handoff that AI needs once it is connected.
 */
export class YourOwnAiRuntime implements AgentRuntime {
  readonly runClass: RunClass = 'your_own_ai';

  async *execute(ctx: AgentRunContext): AsyncIterable<AgentStep> {
    yield {
      tool: 'principal.resolve',
      summary: `Resolved principal — acting as the owner with \`${ctx.principal.scope}\` scope`,
      detail:
        `Declared scopes: ${ctx.agent.scopes.length ? ctx.agent.scopes.join(', ') : '(none — defaulted to read)'}. ` +
        `The effective scope is capped at the owner's own (ADR-0010 §2) — that cap holds whether ` +
        `a human or a connected external AI client is the one calling the tools.`,
    };

    const targets = ctx.agent.targetDatabases?.trim();
    yield {
      tool: 'targets.resolve',
      summary: targets ? `Target databases: ${targets}` : 'No target databases configured',
      detail: targets
        ? undefined
        : 'Set "Target databases" on the agent record to scope which data your own AI may act on.',
    };

    if (!ctx.aiConnected) {
      yield {
        tool: 'byo_ai.not_connected',
        summary: 'No workspace API token found — your own AI has nothing to connect to yet',
        detail:
          'This agent is set to "Your own AI", but this workspace has no live API token ' +
          '(Settings → API tokens — "Connect your AI"). Create one and point an MCP client at it ' +
          '(Claude Desktop, ChatGPT connectors, or any MCP-compatible client) before this agent can ' +
          'actually be driven. Nothing was invoked — creating the token is the next real step.',
      };
      return;
    }

    yield {
      tool: 'byo_ai.handoff',
      summary: 'Connected — an external AI client can now drive this agent over MCP',
      detail:
        `Goal: ${ctx.agent.goal?.trim() || '(none set — add one to the agent record)'}.` +
        (ctx.agent.instructions?.trim() ? ` Instructions: ${ctx.agent.instructions.trim()}.` : '') +
        ' Point the connected MCP client at that goal, capped to the scope and target databases ' +
        'resolved above. Nothing runs here — a your-own-AI run is never metered by StoryOS ' +
        '(MN-188) precisely because the tool-driving happens entirely in the client, not in this process.',
    };
  }
}

/**
 * The seam for StoryOS's managed model (metered, decrements prepaid credits,
 * records `cost`). Not configured yet — it throws rather than silently
 * degrading to the non-AI path, which would misreport what a run actually did.
 *
 * Deliberately still a stub even though MN-189's prepaid-credit ledger
 * (AiCreditsService) is real and load-bearing today (canUseManagedAi,
 * recordUsage, the whole balance/expiry/auto-reload machinery) — see #205's
 * CORRECTION. What's missing is not the ledger; it's a model-calling
 * boundary: this codebase has no LLM client, no provider choice, and no
 * prompt/tool-loop shape anywhere yet. Building one now, with no ADR behind
 * it, would be inventing a second seam under cover of "finishing" this one.
 * Wiring a real managed runtime to a real model belongs in its own ticket
 * once that boundary is actually decided.
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
 * Switches on the agent's own "AI mode" field (#205 item 1). An agent that
 * never set it — or a workspace whose Agents database predates the field —
 * gets exactly the behavior every agent has always had: NonAiRuntime.
 * `storyos_ai` still resolves to ManagedAiRuntime, which still throws (see its
 * doc comment) — picking it is honest about what the owner asked for even
 * though the driver behind it isn't built yet.
 */
export function pickRuntime(agent: AgentRunAgent): AgentRuntime {
  switch (agent.aiMode) {
    case 'your_own_ai':
      return new YourOwnAiRuntime();
    case 'storyos_ai':
      return new ManagedAiRuntime();
    case 'non_ai':
    default:
      return new NonAiRuntime();
  }
}

/** The step log, rendered as the markdown list stored in the Run's `Steps`. */
export function stepsToMarkdown(steps: AgentStep[]): string {
  return steps
    .map((s) => `- **${s.tool}** — ${s.summary}${s.detail ? `\n  - ${s.detail}` : ''}`)
    .join('\n');
}
