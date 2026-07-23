import { UnprocessableEntityException } from '@nestjs/common';
import { architectPlanDraftSchema } from '@storyos/schemas';
import type { ArchitectPlanDraft } from '@storyos/schemas';
import type { AiCreditsService } from '../billing/ai-credits.service';
import { AI_CREDIT_MARKUP_MULTIPLIER, MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS } from '../billing/plans';
import type { RunClass } from './agent-runtime';
import type { ManagedAiClient, ManagedAiCompletion } from './managed-ai-client';

/**
 * The proposer seam (#213, ADR-0010 §6 —
 * docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * This deliberately mirrors the runtime seam (`AgentRuntime` / `pickRuntime` in
 * agent-runtime.ts) shape for shape, for the same three reasons:
 *
 *  1. **BYO-AI stays provably unmetered (MN-188).** Planning is the other place
 *     a model could get invoked, so it gets the same class boundary: a proposer
 *     declares its `planClass` and the non-AI proposer calls no model at all.
 *  2. **The e2e test is deterministic without an LLM.** The lead-intake scenario
 *     (#214) must be provable in CI, and it is, because the default proposer is
 *     a pure function.
 *  3. **A real planner slots in later** behind `ArchitectService.proposerFor`,
 *     exactly as a managed runtime slots in behind `AgentsService.runtimeFor`,
 *     without the plan schema, the reviewer flow or `build` changing at all.
 *
 * MN-217c (#246) is that "later": `ManagedAiProposer` and `YourOwnAiProposer`
 * below are real, not stubs. `ArchitectPlanDraft`/`architectPlanDraftSchema`
 * now live in `@storyos/schemas` (rather than a local `Omit<>` type) precisely
 * because a real proposer's output — a model's JSON, or a caller's supplied
 * draft — needs runtime validation, not just a compile-time shape.
 */

export type { ArchitectPlanDraft };

/**
 * `mode` is the caller's up-front choice of proposer — the exact counterpart
 * of an agent's own "AI mode" field (#205 item 1), which is what `pickRuntime`
 * switches on. It is deliberately part of the CALLER's request (the Architect
 * propose endpoint), never inferred from the goal's content: classifying a
 * plan by guessing whether the goal "looks hard" would make the metering
 * decision depend on the goal, not on what the caller asked for, which is
 * exactly the drift ADR-0010 §3's "stamped before any step runs" discipline
 * exists to prevent. Omitted (or `non_ai`) preserves every existing caller's
 * behavior byte for byte — the free, deterministic scenario-template matcher.
 */
export interface ProposeContext {
  workspaceId: string;
  /** The plain-language goal, verbatim. */
  goal: string;
  mode?: RunClass;
  /**
   * `your_own_ai` only: the plan the caller's own connected AI already
   * reasoned out (see `YourOwnAiProposer`), submitted verbatim for this
   * proposer to validate. Never computed by us — that absence is the entire
   * reason your-own-AI planning is unmetered (MN-188), exactly as
   * `YourOwnAiRuntime` never drives a tool loop in-process either.
   */
  suppliedDraft?: unknown;
}

/**
 * A driver for planning. `planClass` is a property of the *proposer*, not of any
 * individual plan — the same property that lets dispatch classify a run before
 * executing anything (ADR-0010 §3).
 *
 * Returns `null` when it cannot plan the goal. Null rather than a throw because
 * "I don't know how to do that" is an ordinary answer a proposer gives, and the
 * service turns it into one 422 with a useful message. A proposer with a more
 * specific complaint (a malformed supplied draft, no usable AI credit, an
 * unconfigured provider) throws its own `UnprocessableEntityException`
 * directly instead — still a 422, just with a message that names the actual
 * problem rather than the generic "no plan for that goal".
 *
 * Async because a real proposer's answer can require network I/O (a model
 * call) — the one deliberate signature change from #213's original synchronous
 * seam, needed the moment a proposer became more than a pure function.
 */
export interface PlanProposer {
  readonly planClass: RunClass;
  propose(ctx: ProposeContext): Promise<ArchitectPlanDraft | null>;
}

/**
 * One recognisable scenario shape.
 *
 * `match` is a list of term groups: the goal must hit at least one term in
 * EVERY group. Two groups ("what" and "do what with it") is a cheap way to keep
 * "delete all the leads" from matching the lead-intake shape.
 */
interface ScenarioShape {
  id: string;
  match: string[][];
  build(goal: string): ArchitectPlanDraft;
}

/**
 * The lead-intake scenario (#214's shipped end-to-end example, ADR-0010 §6):
 * *lead arrives → draft reply → follow-up task → human approval before send.*
 *
 * Note what this is: two ordinary databases, one select field, one agent record
 * and two bindings. Nothing here is engine-private — a person could type all of
 * it into the UI, and after `build` they can edit every bit of it by hand.
 */
const LEAD_INTAKE: ScenarioShape = {
  id: 'lead-intake',
  match: [
    ['lead', 'leads', 'inbound', 'enquiry', 'enquiries', 'inquiry', 'inquiries', 'prospect'],
    ['reply', 'replies', 'respond', 'response', 'draft', 'answer', 'follow up', 'follow-up'],
  ],
  build: (goal) => ({
    summary:
      'When a lead arrives it lands in **Leads** as `New`. The **Lead Intake Assistant** drafts a ' +
      'reply into `Draft reply`, opens a follow-up **Task** linked to the lead, and moves the lead ' +
      'to `Awaiting approval` — a human-gate state. Sending is gated: the assistant proposes the ' +
      'send and the run parks in *Waiting approval* until you approve it. Nothing is sent without ' +
      `a human. (Planned from the goal: "${goal.trim().slice(0, 200)}")`,
    scenario: 'lead-intake',
    databases: [
      {
        name: 'Leads',
        space: 'Sales',
        fields: [
          { name: 'Email', type: 'email' },
          { name: 'Company', type: 'text' },
          { name: 'Message', type: 'rich_text' },
          // Where the assistant writes. Staged work is ordinary data: a human
          // reads and edits the draft in the record before approving the send.
          { name: 'Draft reply', type: 'rich_text' },
        ],
      },
      {
        name: 'Tasks',
        space: 'Sales',
        fields: [
          { name: 'Due date', type: 'date' },
          { name: 'Notes', type: 'rich_text' },
        ],
      },
    ],
    relations: [
      // Tasks is the "many" side: each follow-up task belongs to one lead.
      {
        from: 'Tasks',
        to: 'Leads',
        cardinality: 'one_to_many',
        from_field: 'Lead',
        to_field: 'Tasks',
      },
    ],
    states: [
      {
        database: 'Leads',
        field: 'Status',
        options: [
          { label: 'New', color: 'blue' },
          { label: 'Drafting reply', color: 'gold' },
          // The checkpoint. First-class, not a convention (ADR-0010 §5).
          { label: 'Awaiting approval', color: 'orange' },
          { label: 'Sent', color: 'green' },
          { label: 'Closed', color: 'gray' },
        ],
      },
      {
        database: 'Tasks',
        field: 'Status',
        options: [
          { label: 'Open', color: 'blue' },
          { label: 'Done', color: 'green' },
        ],
      },
    ],
    agents: [
      {
        name: 'Lead Intake Assistant',
        goal: 'Draft a reply to each new lead and open a follow-up task, then wait for a human to approve the send.',
        instructions:
          'When a lead enters New: read the lead\'s message, write a short personalised reply into ' +
          '"Draft reply", create a follow-up Task linked to the lead, and move the lead to ' +
          '"Awaiting approval". Never send anything yourself — propose the send and stop.',
        // Write, not admin: drafting a reply and opening a task is data work.
        // The ceiling is still capped by the owner's own scope (ADR-0010 §2).
        scopes: ['read', 'write'],
        // The gates. `email`/`outward` are what a send would be classed as, so
        // the send parks instead of happening.
        approval_policy: ['email', 'outward'],
        target_databases: ['Leads', 'Tasks'],
      },
    ],
    triggers: [
      {
        agent: 'Lead Intake Assistant',
        database: 'Leads',
        state_field: 'Status',
        state_option: 'New',
        human_gate: false,
      },
      // The checkpoint binding: the agent is bound to the gate state, but the
      // gate means only a human move advances a lead out of it.
      {
        agent: 'Lead Intake Assistant',
        database: 'Leads',
        state_field: 'Status',
        state_option: 'Awaiting approval',
        human_gate: true,
      },
    ],
  }),
};

/**
 * The scenario library. Small on purpose — see the honesty note on NonAiProposer.
 */
export const SCENARIO_SHAPES: ScenarioShape[] = [LEAD_INTAKE];

/**
 * The default proposer: **template matching, not language understanding**.
 *
 * Read that again before trusting it. This proposer does not comprehend a goal.
 * It lowercases the string and looks for keywords from a hand-written library of
 * scenario shapes; if the keywords hit, it returns that shape's plan, and the
 * only thing the goal contributes to the output is a quoted echo in the summary.
 * A goal it has no template for gets `null` — it will never improvise, and it
 * should not be described (in a changelog, a demo, or a PR) as understanding
 * anything.
 *
 * That limit is deliberate rather than embarrassing. #213's job is the *plan as
 * a reviewable artefact* and #214's is *building it through ordinary CRUD*; both
 * are fully exercised by a deterministic proposer, and both stay exercised in CI
 * regardless of whether `ManagedAiProposer`/`YourOwnAiProposer` are configured.
 * Shipping the seam with a template underneath — and keeping it as the DEFAULT
 * when a caller doesn't opt into a mode — is what keeps the lead-intake e2e
 * test honest, free, and unaffected by #246.
 */
export class NonAiProposer implements PlanProposer {
  readonly planClass: RunClass = 'non_ai';

  async propose(ctx: ProposeContext): Promise<ArchitectPlanDraft | null> {
    const goal = ctx.goal.toLowerCase();
    const shape = SCENARIO_SHAPES.find((s) =>
      s.match.every((group) => group.some((term) => goal.includes(term))),
    );
    return shape ? shape.build(ctx.goal) : null;
  }
}

/**
 * The BYO-AI proposer (#246, mirrors `YourOwnAiRuntime` in agent-runtime.ts).
 *
 * It makes NO model call — by construction, that absence is the entire reason
 * your-own-AI planning is unmetered (MN-188), exactly as it is for the runtime
 * seam. The reasoning happens entirely in an external MCP client the workspace
 * has connected with its own model (Claude Desktop, ChatGPT connectors, or any
 * MCP-compatible client): it reads the goal, works out a plan matching
 * `ArchitectPlanDraft`'s shape, and submits that plan verbatim as `draft`. This
 * proposer's whole job is what `YourOwnAiRuntime` does for a run — check the
 * real precondition and validate what comes back — not to plan anything itself.
 *
 * This is also why a goal outside the scenario library gets a genuinely
 * concrete plan through this path: the "understanding" is real, it just never
 * happens inside this process.
 */
export class YourOwnAiProposer implements PlanProposer {
  readonly planClass: RunClass = 'your_own_ai';

  async propose(ctx: ProposeContext): Promise<ArchitectPlanDraft | null> {
    if (ctx.suppliedDraft === undefined) {
      throw new UnprocessableEntityException(
        'mode "your_own_ai" requires `draft` — the plan your own connected AI already reasoned ' +
          'out (matching the ArchitectPlanDraft shape: summary, scenario, databases, relations, ' +
          'states, agents, triggers — no `action` on databases, that is resolved here against live ' +
          'schema), submitted verbatim. This proposer never calls a model itself — that is what ' +
          'keeps it unmetered (MN-188): your own AI does the reasoning, this endpoint only validates ' +
          'and (on build) executes it.',
      );
    }
    const parsed = architectPlanDraftSchema.safeParse(ctx.suppliedDraft);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `\`draft\` is not a valid Architect plan draft: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }
}

/**
 * Build the prompt asking a managed model for a plan matching
 * `ArchitectPlanDraft`. Deliberately compact rather than a copy of the zod
 * schema in prose — the schema is re-validated on the way back regardless
 * (see `ManagedAiProposer.propose`), so this prompt only needs to get the
 * model CLOSE; it is not the source of truth for what is accepted.
 */
export function buildProposePrompt(goal: string): string {
  return [
    'You are planning a small workflow for a no-code relational-database + agents product ' +
      '(databases with typed fields, a workflow "state" is a select field, an agent is bound to ' +
      'a database state and can be gated behind human approval).',
    'Given the goal below, respond with ONLY a single JSON object (no prose, no markdown fences) ' +
      'matching exactly this shape:',
    JSON.stringify(
      {
        summary: 'string — one paragraph a human can approve or reject',
        scenario: 'string — a short kebab-case id for this plan, e.g. "expense-approval"',
        databases: [
          {
            name: 'string',
            space: 'string — the space/folder this database belongs in',
            fields: [
              {
                name: 'string',
                type: 'one of: text, rich_text, number, checkbox, date, select, multi_select, url, email, color, user',
                options: '[{label, color?}] — only for select/multi_select',
              },
            ],
          },
        ],
        relations: [
          {
            from: 'string — database name, the "many" side',
            to: 'string — database name',
            cardinality: 'one_to_many or many_to_many',
            from_field: 'string — field created on `from`',
            to_field: 'string — field created on `to`',
          },
        ],
        states: [
          {
            database: 'string — database name',
            field: 'string — e.g. "Status"',
            options: '[{label, color?}] — at least one',
          },
        ],
        agents: [
          {
            name: 'string',
            goal: 'string',
            instructions: 'string (optional)',
            scopes: '["read"|"write"|"admin", ...]',
            approval_policy: '["delete"|"webhook"|"email"|"run_button"|"outward", ...] — actions needing a human',
            target_databases: '[string, ...] — database names this agent may act on',
          },
        ],
        triggers: [
          {
            agent: 'string — agent name',
            database: 'string — database name',
            state_field: 'string — the select field name',
            state_option: 'string — the option label that fires this agent',
            human_gate: 'boolean — true means a human must move it out manually',
          },
        ],
      },
      null,
      2,
    ),
    'Do NOT include an `action` key on any database — that is decided separately against live ' +
      'schema, never by you.',
    'Use one to three databases, name real fields, and gate anything that sends/deletes/calls out ' +
      'behind a human-approval trigger (human_gate: true) the same way a careful person would design ' +
      'this by hand.',
    '',
    `Goal: "${goal.trim()}"`,
  ].join('\n');
}

/**
 * The managed proposer (#246, MN-217c): a real call to StoryOS's managed
 * model, metered against this workspace's AI credit balance (`storyos_ai`
 * plan class). Depends on `ManagedAiClient` (never a concrete provider SDK —
 * same reasoning as `AgentRuntime` depending on the runtime interface) and
 * `AiCreditsService`, both injected by `ArchitectService.proposerFor` (see
 * architect.service.ts) rather than constructed here, so tests can supply
 * fakes for both without a real network call or a real ledger.
 *
 * The credit gate runs BEFORE the model call — the propose-time analogue of
 * "classify before any step runs" (ADR-0010 §3): a workspace with no usable
 * balance never reaches the network, rather than spending real money on a
 * call whose cost it then can't charge.
 */
export class ManagedAiProposer implements PlanProposer {
  readonly planClass: RunClass = 'storyos_ai';

  constructor(
    private readonly client: ManagedAiClient | undefined,
    private readonly aiCredits: AiCreditsService,
  ) {}

  async propose(ctx: ProposeContext): Promise<ArchitectPlanDraft | null> {
    if (!this.client) {
      // A direct 422 (not the ManagedAiRuntime stub's bare Error) because this
      // is a synchronous API boundary, not a step inside a longer async run —
      // the caller needs an actionable answer, not a 500.
      throw new UnprocessableEntityException(
        'The managed AI proposer is not configured for this deployment (no OPENAI_API_KEY set). ' +
          'Propose with mode "non_ai" (the scenario templates) or "your_own_ai" (supply your own ' +
          'plan draft) instead.',
      );
    }

    const canUse = await this.aiCredits.canUseManagedAi(ctx.workspaceId);
    if (!canUse) {
      throw new UnprocessableEntityException(
        'StoryOS AI has no usable credit balance for this workspace (MN-189 — the feature turns ' +
          'off rather than overdraft). Add credits (and a payment method) in Settings → Billing, or ' +
          'propose with mode "non_ai" / "your_own_ai" instead.',
      );
    }

    const completion = await this.client.complete(buildProposePrompt(ctx.goal));

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(completion.text);
    } catch {
      // The call happened and cost real tokens even though the output was
      // unusable — meter it (see chargeUsage), then fail cleanly rather than
      // half-build anything (#246 AC).
      await this.chargeUsage(ctx.workspaceId, completion);
      throw new UnprocessableEntityException(
        'The managed AI did not return valid JSON for a plan. Try rephrasing the goal — a bad ' +
          'model response never half-builds anything.',
      );
    }

    const parsed = architectPlanDraftSchema.safeParse(parsedJson);
    await this.chargeUsage(ctx.workspaceId, completion);

    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `The managed AI produced an invalid plan: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  /** MN-188's ledger charge for one propose call — real tokensIn/tokensOut
   * from the provider's response, unlike ManagedAiRuntime's still-stubbed 0/0
   * (see plans.ts's MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS for why the
   * dollar cost itself is still a flat placeholder). */
  private async chargeUsage(workspaceId: string, completion: ManagedAiCompletion): Promise<void> {
    const ourCostCents = MANAGED_AI_PROPOSE_PLACEHOLDER_COST_CENTS;
    await this.aiCredits.recordUsage(workspaceId, {
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      ourCostCents,
      creditsChargedCents: ourCostCents * AI_CREDIT_MARKUP_MULTIPLIER,
    });
  }
}

/** What `ArchitectService.proposerFor` needs to construct a proposer per call. */
export interface ProposerDeps {
  aiCredits: AiCreditsService;
  /** `undefined` when OPENAI_API_KEY is unset — see managed-ai-client.ts. */
  managedAiClient?: ManagedAiClient;
}

/**
 * Choose the proposer for a call — and therefore the plan's class.
 *
 * The exact counterpart of `pickRuntime` (agent-runtime.ts): switches on the
 * CALLER's own choice (`ctx.mode`), never on the goal's content, for the same
 * reason `pickRuntime` switches on the agent's own configured "AI mode" rather
 * than guessing from what the agent does. Omitted (or `non_ai`) is exactly
 * what every existing caller already gets — the free, deterministic
 * scenario-template matcher — so #246 changes nothing for a caller that
 * doesn't opt in.
 */
export function pickProposer(ctx: ProposeContext, deps: ProposerDeps): PlanProposer {
  switch (ctx.mode) {
    case 'your_own_ai':
      return new YourOwnAiProposer();
    case 'storyos_ai':
      return new ManagedAiProposer(deps.managedAiClient, deps.aiCredits);
    case 'non_ai':
    default:
      return new NonAiProposer();
  }
}

/** The scenario ids the non-AI proposer can actually plan, for a 422's message. */
export function knownScenarios(): string[] {
  return SCENARIO_SHAPES.map((s) => s.id);
}
