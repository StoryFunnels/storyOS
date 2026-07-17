import type { ArchitectPlan, PlanDatabase } from '@storyos/schemas';
import type { RunClass } from './agent-runtime';

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
 */

/**
 * A plan before create-vs-reuse has been resolved.
 *
 * A proposer describes the *shape* it wants; whether each database already
 * exists is a fact about the workspace, not about the goal, so `action` is
 * decided by ArchitectService against live schema (see `resolveActions`). This
 * split is what stops a proposer — template or model — from ever being the thing
 * that claims a database is new.
 */
export type ArchitectPlanDraft = Omit<ArchitectPlan, 'databases'> & {
  databases: Array<Omit<PlanDatabase, 'action'>>;
};

export interface ProposeContext {
  workspaceId: string;
  /** The plain-language goal, verbatim. */
  goal: string;
}

/**
 * A driver for planning. `planClass` is a property of the *proposer*, not of any
 * individual plan — the same property that lets dispatch classify a run before
 * executing anything (ADR-0010 §3).
 *
 * Returns `null` when it cannot plan the goal. Null rather than a throw because
 * "I don't know how to do that" is an ordinary answer a proposer gives, and the
 * service turns it into one 422 with a useful message.
 */
export interface PlanProposer {
  readonly planClass: RunClass;
  propose(ctx: ProposeContext): ArchitectPlanDraft | null;
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
 * once a real planner lands behind `ManagedAiProposer`. Shipping the seam with a
 * template underneath is what keeps the lead-intake e2e test honest and free.
 */
export class NonAiProposer implements PlanProposer {
  readonly planClass: RunClass = 'non_ai';

  propose(ctx: ProposeContext): ArchitectPlanDraft | null {
    const goal = ctx.goal.toLowerCase();
    const shape = SCENARIO_SHAPES.find((s) =>
      s.match.every((group) => group.some((term) => goal.includes(term))),
    );
    return shape ? shape.build(ctx.goal) : null;
  }
}

/**
 * The seam for planning on StoryOS's managed model (metered). Not configured
 * yet — it throws rather than silently degrading to template matching, which
 * would quietly hand back a plan for a goal nobody templated.
 */
export class ManagedAiProposer implements PlanProposer {
  readonly planClass: RunClass = 'storyos_ai';

  propose(_ctx: ProposeContext): ArchitectPlanDraft | null {
    throw new Error('Managed AI proposer not configured');
  }
}

/**
 * Choose the proposer for a goal — and therefore the plan's class.
 *
 * The exact counterpart of `pickRuntime` (agent-runtime.ts): today everything
 * gets the non-AI proposer, and selecting a BYO-AI/managed planner arrives with
 * the planner itself.
 */
export function pickProposer(_ctx: ProposeContext): PlanProposer {
  return new NonAiProposer();
}

/** The scenario ids the non-AI proposer can actually plan, for a 422's message. */
export function knownScenarios(): string[] {
  return SCENARIO_SHAPES.map((s) => s.id);
}
