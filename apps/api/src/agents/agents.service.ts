import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { blocksToMarkdown, markdownToBlocks } from '@storyos/schemas';
import type { AutomationAction, TokenScope } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  apiTokens,
  databases as databasesTable,
  fields as fieldsTable,
  memberships as membershipsTable,
  records as recordsTable,
  selectOptions,
} from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AutomationActionsService } from '../automations/actions.service';
import { JobRunnerService } from '../automations/job-runner.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AiCreditsService } from '../billing/ai-credits.service';
import { CommentsService } from '../comments/comments.service';
import type { CommentSegment } from '../comments/comments.service';
import {
  AI_CREDIT_MARKUP_MULTIPLIER,
  STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS,
} from '../billing/plans';
import { deriveAgentPrincipal, scopeForRole } from './agent-principal';
import {
  pickRuntime,
  proposedActionPayloadSchema,
  RUN_CLASS_BY_LABEL,
  RUN_CLASS_LABEL,
  stepsToMarkdown,
} from './agent-runtime';
import type { AgentRuntime, AgentRunAgent, AgentStep, ProposedAction } from './agent-runtime';

type Database = typeof databasesTable.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Base backoff between run-execution retries; doubles per attempt (#212). */
const DEFAULT_RETRY_DELAY_MS = 50;

/** The Run record's "Trigger" select labels — how a run came to be.
 * 'Automation' (MN-109 Phase A) is a regular automation rule or button —
 * schedule / record event / button — as opposed to the Architect's
 * state-transition bindings ('State change', #212). */
export type RunTrigger = 'Manual' | 'State change' | 'Schedule' | 'Automation';

/**
 * Guardrails a caller can layer onto a dispatch (MN-109 Phase A). All optional
 * and additive — omitting this object entirely (every pre-existing caller)
 * preserves dispatchRun's exact prior behavior.
 */
export interface DispatchRunGuardrails {
  /** Further caps the agent's own declared Scopes for this run only — can
   * only narrow, never widen (ADR-0010 §2). */
  scopeCap?: string[];
  /** If set, any proposed action whose kind isn't listed here is staged for
   * approval regardless of the agent's own Approval policy. */
  allowedActionKinds?: string[];
  /** Hard cap on steps executed this attempt. Exceeding it fails the run with
   * a clear reason rather than truncating it silently. */
  maxSteps?: number;
  /** Refuse to execute (Failed immediately, before any step runs) if the run's
   * classified cost would exceed this many cents. Only meaningful for a
   * 'storyos_ai'-classified run — non_ai/your_own_ai runs have no cost to
   * compare against yet. */
  maxCostCents?: number;
  /** Never apply a proposed action for real — log what would happen instead. */
  dryRun?: boolean;
}

/**
 * What the Run's `Pending action` holds while a run is Waiting approval (#210).
 *
 * The staged action, plus the steps that led to it. The steps ride along because
 * approve/reject have to re-render the whole log with their verdict appended,
 * and `Steps` is a rendered BlockNote document — parsing markdown back out of
 * blocks to append one line would be a lossy round trip. This blob is the run's
 * suspended state; `Steps` is its human-readable projection.
 */
interface StagedAction {
  action: ProposedAction;
  steps: AgentStep[];
}

/** Parse a Run's `Pending action` JSON, or null if it isn't staged/parseable. */
function parseStaged(raw: unknown): StagedAction | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as StagedAction;
    return parsed && typeof parsed === 'object' && parsed.action ? parsed : null;
  } catch {
    return null;
  }
}

/** Everything the shared run path needs, independent of how it was triggered. */
export interface DispatchRunInput {
  workspaceId: string;
  agentsDb: Database;
  runsDb: Database;
  /** The agent record to run. Callers decide what `Enabled: false` means. */
  agentRecord: ProjectedRecord;
  trigger: RunTrigger;
  /** The record that triggered this run — the agent's context (ADR-0010 §5). */
  inputRecordId?: string;
  /**
   * The identity the run acts as: the agent's owner and their scope ceiling.
   * `deriveAgentPrincipal` can only narrow it, never widen it (ADR-0010 §2).
   */
  owner: { userId: string; scope: TokenScope };
  /** Extra execution attempts after the first (ADR-0010 §5). Default 0. */
  retries?: number;
  retryDelayMs?: number;
  /** The triggering event's depth, carried into the agent's own writes. */
  depth?: number;
  /** MN-109 Phase A: a run_agent action's `prompt` — overrides the agent's own
   * Goal for this run only. Undefined for every pre-existing caller. */
  promptOverride?: string;
  /** MN-109 Phase A guardrails — see DispatchRunGuardrails. */
  guardrails?: DispatchRunGuardrails;
}

/**
 * Agents + Runs system databases (MN-214a / #209, ADR-0010 —
 * docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * The keystone of the Agentic OS foundation: an agent is a first-class *record*
 * in an ordinary StoryOS database, not a bespoke drizzle table. Making agents
 * records means views, filters, comments, permissions and export all work on
 * them for free (ADR-0010 §1). This service provisions those databases the same
 * way the GitHub integration provisions its pack — idempotently, found-by-name,
 * with no migration.
 */
@Injectable()
export class AgentsService implements OnModuleInit {
  /**
   * The dispatch-time runtime choice (#205). Swappable in tests, like
   * GithubService.fetcher — it is the seam a managed/BYO driver plugs into.
   */
  runtimeFor: (agent: AgentRunAgent) => AgentRuntime = pickRuntime;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
    /** #210: applies an approved action — the executor buttons/automations use. */
    private readonly actions: AutomationActionsService,
    /** #210: asks the owner, through the Inbox they already watch. */
    private readonly notifications: NotificationsService,
    /** MN-168: the non-AI allowance a run_class='non_ai' run is checked and counted against. */
    private readonly entitlements: EntitlementsService,
    /** MN-188/MN-189: the prepaid-credit ledger a run_class='storyos_ai' run decrements. */
    private readonly aiCredits: AiCreditsService,
    /** #44: posts a delegated run's outcome back onto the record it was delegated on. */
    private readonly comments: CommentsService,
    /** MN-109 Phase A: the durable queue a run_agent automation action runs
     * through — an agent run is long-running like the external kinds MN-253
     * built this for, so it registers 'run_agent' the same way MN-256/257/
     * 258/259/263's provider modules register theirs. */
    private readonly jobs: JobRunnerService,
  ) {}

  /** MN-109 Phase A: register the run_agent job kind at bootstrap. The moment
   * this runs, actions.service.ts's execute() routes any `run_agent` action
   * through the durable queue automatically (JobRunnerService.hasExecutor) —
   * no change needed there. */
  onModuleInit(): void {
    this.jobs.registerExecutor(
      'run_agent',
      async (payload) => {
        const action = payload['action'] as Extract<AutomationAction, { type: 'run_agent' }>;
        const ctx = payload['ctx'] as {
          workspaceId: string;
          databaseId: string;
          recordId: string | null;
          actorId: string;
          depth?: number;
        };
        const run = await this.runFromAutomation({
          workspaceId: ctx.workspaceId,
          agentRef: action.agent,
          // Phase A's only supported target: the record that fired the rule
          // or button (absent for a webhook_received rule, but run_agent is
          // never in WEBHOOK_SAFE_ACTIONS, so that combination 422s at save
          // time before it ever reaches here).
          inputRecordId: ctx.recordId ?? undefined,
          // Carries the SAME depth the rule's own actions.execute() call used
          // (already incremented past the triggering event) — without this an
          // agent's write-back through a job would always look like depth 0
          // and the automations loop guard could never bound a cycle.
          depth: ctx.depth ?? 0,
          prompt: action.prompt,
          toolScope: action.tool_scope,
          maxSteps: action.max_steps,
          maxCostCents: action.max_cost_cents,
          dryRun: action.dry_run,
        });
        return { runId: run.id, status: run.values['status'] };
      },
      { timeoutClass: 'long' },
    );
  }

  /**
   * The pack's databases, as far as they have been provisioned. Public because
   * the trigger subscriber (#212) resolves the pack from a bare workspace id —
   * a domain event carries no membership.
   */
  async findPackDbs(workspaceId: string) {
    const all = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, workspaceId),
    });
    return {
      agentsDb: all.find((d) => d.name === 'Agents'),
      runsDb: all.find((d) => d.name === 'Runs'),
      triggersDb: all.find((d) => d.name === 'Agent Triggers'),
    };
  }

  /** Add a field to a pack database if it isn't there yet, found by api_name. */
  private async ensureField(
    databaseId: string,
    apiName: string,
    spec: Parameters<FieldsService['create']>[1],
  ): Promise<void> {
    const existing = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    if (!existing) await this.fields.create(databaseId, spec);
  }

  /** Add an option to a select/multi_select field if it isn't there yet, by
   * label — the same idempotent-backfill shape ensureField() uses, one level
   * down (MN-109 Phase A's "Automation" Trigger option on pre-existing packs). */
  private async ensureSelectOption(
    databaseId: string,
    apiName: string,
    label: string,
    color: string,
  ): Promise<void> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    if (!field) return; // field doesn't exist on this pack version — nothing to add the option to
    const existingOptions = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, field.id),
    });
    if (existingOptions.some((o) => o.label === label)) return;
    await this.fields.addOption(databaseId, field.id, { label, color });
  }

  /** label → option id for a select/multi_select field, for writing values. */
  private async optionIdsByLabel(
    databaseId: string,
    apiName: string,
  ): Promise<Map<string, string>> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    const options = field
      ? await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, field.id) })
      : [];
    return new Map(options.map((o) => [o.label, o.id]));
  }

  /** option id → label, for reading multi_select values back off a record. */
  private async optionLabelsById(
    databaseId: string,
    apiName: string,
  ): Promise<Map<string, string>> {
    const byLabel = await this.optionIdsByLabel(databaseId, apiName);
    return new Map([...byLabel].map(([label, id]) => [id, label]));
  }

  /**
   * Find-or-create the "Agentic OS" space + the "Agents" and "Runs" databases
   * and their fields. Idempotent by database name: a second call returns the
   * same databases and adds nothing (mirrors GithubService.ensurePack).
   *
   * Each database is provisioned independently, so a workspace provisioned
   * before #209 (Agents only) gains Runs on its next ensure.
   */
  async ensurePack(
    membership: Membership,
  ): Promise<{ agentsDb: Database; runsDb: Database; triggersDb: Database; created: boolean }> {
    const existing = await this.findPackDbs(membership.workspaceId);
    if (existing.agentsDb && existing.runsDb && existing.triggersDb) {
      return {
        agentsDb: existing.agentsDb,
        runsDb: existing.runsDb,
        triggersDb: existing.triggersDb,
        created: false,
      };
    }

    const allSpaces = await this.spaces.list(membership);
    const space =
      allSpaces.find((s) => s.name === 'Agentic OS') ??
      (await this.spaces.create(membership.workspaceId, { name: 'Agentic OS', icon: '🤖' }));

    let agentsDb = existing.agentsDb;
    if (!agentsDb) {
      agentsDb = (await this.databasesService.create(membership, {
        space_id: space.id,
        name: 'Agents',
        icon: '🤖',
      })) as Database;

      // The record title is the agent name (the auto title field). Everything else
      // is the agent's definition per ADR-0010 §1.
      const agentFields: Array<Parameters<FieldsService['create']>[1]> = [
        { display_name: 'Goal', type: 'rich_text', config: {} },
        { display_name: 'Instructions', type: 'rich_text', config: {} },
        {
          display_name: 'Scopes',
          type: 'multi_select',
          config: {},
          options: [
            { label: 'read', color: 'blue' },
            { label: 'write', color: 'orange' },
            { label: 'admin', color: 'red' },
          ],
        },
        {
          display_name: 'Trigger',
          type: 'select',
          config: {},
          // "Manual" is the default concept — the manual run ships before the
          // state/schedule runtimes exist (ADR-0010 §3). "Automation" (MN-109
          // Phase A) is a regular rule/button, as opposed to "State change"'s
          // dedicated bindings (#211).
          options: [
            { label: 'Manual', color: 'gray' },
            { label: 'State change', color: 'green' },
            { label: 'Schedule', color: 'purple' },
            { label: 'Automation', color: 'teal' },
          ],
        },
        // TODO(#206): a relation to "databases" isn't possible while databases
        // aren't records, so target databases are stored as text (names/ids) for
        // now. Replace with a richer target-picker once databases are addressable.
        { display_name: 'Target databases', type: 'text', config: {} },
        {
          // #205 item 1: the owner's own choice of driver — the field
          // pickRuntime reads via dispatchRun's runtimeFor(agent) call. Same
          // three labels as Runs."Run class" (RUN_CLASS_LABEL) so a run's
          // stamped class always reads back as what the agent asked for.
          // Unset (or missing on a workspace whose Agents database predates
          // this field) means exactly what every agent has always done:
          // Non-AI.
          display_name: 'AI mode',
          type: 'select',
          config: {},
          options: [
            { label: 'Non-AI', color: 'gray' },
            { label: 'Your own AI', color: 'green' },
            { label: 'StoryOS AI', color: 'purple' },
          ],
        },
        {
          display_name: 'Approval policy',
          type: 'multi_select',
          config: {},
          options: [
            { label: 'delete', color: 'red' },
            { label: 'webhook', color: 'orange' },
            { label: 'email', color: 'gold' },
            { label: 'run_button', color: 'blue' },
            { label: 'outward', color: 'purple' },
          ],
        },
        { display_name: 'Enabled', type: 'checkbox', config: {} },
      ];
      for (const f of agentFields) await this.fields.create(agentsDb.id, f);
    }

    // #205 ships after the Agents database (MN-214a), so a pack provisioned
    // before it has every field above except "AI mode". Back-fill it the same
    // way Runs."Pending action" is back-filled below — idempotent, and a
    // no-op on an agentsDb just created above.
    await this.ensureField(agentsDb.id, 'ai_mode', {
      display_name: 'AI mode',
      type: 'select',
      config: {},
      options: [
        { label: 'Non-AI', color: 'gray' },
        { label: 'Your own AI', color: 'green' },
        { label: 'StoryOS AI', color: 'purple' },
      ],
    });

    let runsDb = existing.runsDb;
    if (!runsDb) {
      runsDb = (await this.databasesService.create(membership, {
        space_id: space.id,
        name: 'Runs',
        icon: '▶️',
      })) as Database;

      // The Run record (ADR-0010 §1): what ran, how it was driven, what it cost,
      // and the step log. The title is "<agent> — <trigger>".
      const runFields: Array<Parameters<FieldsService['create']>[1]> = [
        {
          display_name: 'Trigger',
          type: 'select',
          config: {},
          options: [
            { label: 'Manual', color: 'gray' },
            { label: 'State change', color: 'green' },
            { label: 'Schedule', color: 'purple' },
            { label: 'Automation', color: 'teal' },
          ],
        },
        {
          display_name: 'Status',
          type: 'select',
          config: {},
          options: [
            { label: 'Queued', color: 'gray' },
            { label: 'Running', color: 'blue' },
            { label: 'Waiting approval', color: 'gold' },
            { label: 'Succeeded', color: 'green' },
            { label: 'Failed', color: 'red' },
            { label: 'Canceled', color: 'brown' },
          ],
        },
        {
          // MN-188: the metering boundary. Stamped at dispatch, before any step
          // executes, so "your own AI is never metered" is a property of the code.
          display_name: 'Run class',
          type: 'select',
          config: {},
          options: [
            { label: 'Non-AI', color: 'gray' },
            { label: 'Your own AI', color: 'green' },
            { label: 'StoryOS AI', color: 'purple' },
          ],
        },
        // TODO(#209): the input record can live in any database, so it is stored
        // as an id (text) rather than a relation — a relation needs a single fixed
        // target database. Revisit with the state-change dispatcher (#215).
        { display_name: 'Input record', type: 'text', config: {} },
        { display_name: 'Cost', type: 'number', config: {} },
        { display_name: 'Started at', type: 'date', config: { include_time: true } },
        { display_name: 'Finished at', type: 'date', config: { include_time: true } },
        { display_name: 'Steps', type: 'rich_text', config: {} },
        // #210 / ADR-0010 §4: the staged action, as DATA. Text holding JSON, not
        // rich_text — this is machine state read back by approve/reject, and a
        // BlockNote document would mangle a payload on the round trip. Cleared
        // the moment the gate is resolved either way, so a non-empty value means
        // exactly "this run is blocked on a human".
        { display_name: 'Pending action', type: 'text', config: {} },
      ];
      for (const f of runFields) await this.fields.create(runsDb.id, f);

      // An agent has many runs: each Run points at exactly one Agent ("Agent"),
      // each Agent owns a collection of them ("Runs"). Side A is the "many" side
      // that carries the single reference.
      await this.relationsService.create(membership, {
        database_a_id: runsDb.id,
        database_b_id: agentsDb.id,
        cardinality: 'one_to_many',
        field_a_name: 'Agent',
        field_b_name: 'Runs',
      });
    }

    // #210 ships after Runs (#209), so a Runs database provisioned by the
    // previous release has every field above except "Pending action". Back-fill
    // it rather than only creating it with the database: without somewhere to
    // stage, the gate would have to either fail the run or — far worse — let the
    // action through. Idempotent, and a no-op on a database just created above.
    await this.ensureField(runsDb.id, 'pending_action', {
      display_name: 'Pending action',
      type: 'text',
      config: {},
    });

    // MN-109 Phase A ships after Runs (#209) and Agents (#209), so a pack
    // provisioned by an earlier release has a "Trigger" field on both Agents
    // and Runs with only three options — back-fill "Automation" onto both,
    // the same reasoning as "Pending action" above: without the option, a
    // run_agent dispatch would write a null Trigger rather than a Run nobody
    // can tell came from an automation. Idempotent, and a no-op immediately
    // after either database was just created above (the option is already there).
    await this.ensureSelectOption(agentsDb.id, 'trigger', 'Automation', 'teal');
    await this.ensureSelectOption(runsDb.id, 'trigger', 'Automation', 'teal');

    let triggersDb = existing.triggersDb;
    if (!triggersDb) {
      triggersDb = (await this.databasesService.create(membership, {
        space_id: space.id,
        name: 'Agent Triggers',
        icon: '⚡',
      })) as Database;

      // The binding record (#211, ADR-0010 §5): `(database, state, agent)` — the
      // core loop's declaration that "a record entering state S runs agent A".
      const triggerFields: Array<Parameters<FieldsService['create']>[1]> = [
        // TODO(#206): a relation to the target database isn't possible while
        // databases aren't records, so the target is stored as its id (text).
        // Same constraint as Agents."Target databases" and Runs."Input record".
        { display_name: 'Database', type: 'text', config: {} },
        // Likewise the select field and the option that fires it: ids, resolved
        // and validated against the target database by validateBinding().
        { display_name: 'State field', type: 'text', config: {} },
        { display_name: 'State option', type: 'text', config: {} },
        // ADR-0010 §5: a human-gate state never auto-fires an agent *out* of it.
        // Checkpoints are first-class — only a human move advances a gated state.
        { display_name: 'Human gate', type: 'checkbox', config: {} },
        { display_name: 'Enabled', type: 'checkbox', config: {} },
      ];
      for (const f of triggerFields) await this.fields.create(triggersDb.id, f);

      // An agent has many bindings: each binding fires exactly one Agent
      // ("Agent"), each Agent owns its collection of them ("Triggers"). Side A
      // is the "many" side that carries the single reference.
      await this.relationsService.create(membership, {
        database_a_id: triggersDb.id,
        database_b_id: agentsDb.id,
        cardinality: 'one_to_many',
        field_a_name: 'Agent',
        field_b_name: 'Triggers',
      });
    }

    return { agentsDb, runsDb, triggersDb, created: true };
  }

  /**
   * Summary of the pack's databases if provisioned, else `{ exists: false }`.
   * Agent and Run records themselves are read/created through the normal records
   * API on these databases — this service does not duplicate record CRUD.
   */
  async getPack(membership: Membership): Promise<
    | {
        exists: true;
        id: string;
        name: string;
        runs: { id: string; name: string } | null;
        triggers: { id: string; name: string } | null;
      }
    | { exists: false }
  > {
    const { agentsDb, runsDb, triggersDb } = await this.findPackDbs(membership.workspaceId);
    if (!agentsDb) return { exists: false };
    return {
      exists: true,
      id: agentsDb.id,
      name: agentsDb.name,
      // Provisioned separately, so a pre-#209 workspace reports Agents without Runs
      // until its next ensure — likewise Agent Triggers before #211.
      runs: runsDb ? { id: runsDb.id, name: runsDb.name } : null,
      triggers: triggersDb ? { id: triggersDb.id, name: triggersDb.name } : null,
    };
  }

  /**
   * MN-188 — the other half of MN-189's ledger: decrement prepaid credits for
   * a completed StoryOS-AI run, via AiCreditsService.recordUsage (never a
   * parallel mechanism). Called from both places a run can reach a final,
   * successful outcome: the immediate Succeeded path in dispatchRun, and the
   * approve path in resolveGate (a storyos_ai run can stage a gated action
   * exactly like a non_ai one can).
   *
   * Idempotent per run: guarded by the Run's own `cost` field. That field is
   * set in the very same call that charges the ledger, so re-invoking this
   * for a run that already has a `cost` is a no-op — mirrors how
   * `pending_action` being cleared guards resolveGate's approve branch against
   * a replay. This re-reads the run rather than trusting the caller's
   * (possibly stale) copy, so calling it twice in a row for the same run id
   * only ever decrements once.
   *
   * The cost charged is STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS — a flat,
   * honestly-labeled placeholder. ManagedAiRuntime (MN-214r) is still a stub
   * with no real token counts to attribute, so tokensIn/tokensOut are
   * recorded as 0 rather than invented. Swap this for real usage the moment a
   * real managed/BYO-driven run reports it.
   */
  private async chargeStoryOsAiRun(
    workspaceId: string,
    runsDbId: string,
    run: ProjectedRecord,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const current = await this.recordsService.get(runsDbId, run.id);
    if (current.values['cost'] != null) return current; // already charged — idempotent no-op

    const ourCostCents = STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS;
    const creditsChargedCents = ourCostCents * AI_CREDIT_MARKUP_MULTIPLIER;

    await this.aiCredits.recordUsage(workspaceId, {
      tokensIn: 0, // unknown until MN-214r's runtime reports real usage
      tokensOut: 0,
      ourCostCents,
      creditsChargedCents,
    });

    return this.recordsService.update(
      workspaceId,
      runsDbId,
      run.id,
      { cost: creditsChargedCents },
      actorId,
    );
  }

  /**
   * The real precondition YourOwnAiRuntime checks (#205 item 1): does this
   * workspace have at least one live (non-revoked) API token — the same
   * "Connect your AI" on-ramp onboarding.controller.ts's `ai_connected`
   * signals, i.e. a credential an external MCP client could actually use to
   * reach this workspace. A revoked token doesn't count — it isn't a working
   * on-ramp any more, whatever onboarding's separate progress checklist says.
   */
  private async hasLiveApiToken(workspaceId: string): Promise<boolean> {
    const row = await this.db.query.apiTokens.findFirst({
      columns: { id: true },
      where: and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)),
    });
    return Boolean(row);
  }

  /** Resolve an agent record by uuid or public number (MN-087 pretty handles). */
  private async resolveAgent(agentsDbId: string, ref: string): Promise<ProjectedRecord> {
    if (UUID_RE.test(ref)) return this.recordsService.get(agentsDbId, ref);
    const number = Number(ref);
    if (!Number.isInteger(number) || number <= 0) throw new NotFoundException('Agent not found');
    return this.recordsService.getByNumber(agentsDbId, number);
  }

  /**
   * The identity a run acts as when there is no calling human (ADR-0010 §2):
   * the agent record's own creator, re-checked against CURRENT membership so
   * a demoted or departed owner narrows or blocks the run rather than one
   * being run under stale privilege. Shared by the state-transition
   * dispatcher (AgentTriggerSubscriber, #212) and the run_agent automation
   * action (MN-109 Phase A) — both dispatch with nobody at the keyboard.
   */
  async resolveAgentOwner(
    workspaceId: string,
    agentRecord: ProjectedRecord,
  ): Promise<{ userId: string; scope: TokenScope } | null> {
    const ownerUserId = agentRecord.created_by;
    if (!ownerUserId) return null;
    const membership = await this.db.query.memberships.findFirst({
      where: and(
        eq(membershipsTable.workspaceId, workspaceId),
        eq(membershipsTable.userId, ownerUserId),
      ),
    });
    if (!membership || membership.status !== 'active') return null;
    return { userId: ownerUserId, scope: scopeForRole(membership.role) };
  }

  /**
   * MN-109 Phase A — the run_agent automation action's entry point. Called
   * from the job-runner executor registered in onModuleInit, once per queued
   * `run_agent` action. Deliberately thin: resolve the agent + owner, then
   * hand off to the SAME dispatchRun() every other trigger uses — this is a
   * new entry surface, not a new engine.
   *
   * Unlike run()/delegate(), there is no admin session to authorize against:
   * the caller is the automations engine itself, so authority comes from the
   * agent's own owner (resolveAgentOwner), exactly like the state-transition
   * dispatcher.
   */
  async runFromAutomation(input: {
    workspaceId: string;
    agentRef: string;
    inputRecordId?: string;
    depth?: number;
    prompt?: string;
    toolScope?: string[];
    maxSteps?: number;
    maxCostCents?: number;
    dryRun?: boolean;
  }): Promise<ProjectedRecord> {
    const { agentsDb, runsDb } = await this.findPackDbs(input.workspaceId);
    if (!agentsDb || !runsDb) {
      throw new UnprocessableEntityException(
        'The Agents pack is not provisioned in this workspace yet — run an agent manually ' +
          '(or POST /agents/ensure) before wiring a run_agent automation to it.',
      );
    }
    const agentRecord = await this.resolveAgent(agentsDb.id, input.agentRef);
    if (agentRecord.values['enabled'] !== true) {
      throw new UnprocessableEntityException(
        'This agent is disabled — enable it before running it from an automation',
      );
    }
    const owner = await this.resolveAgentOwner(input.workspaceId, agentRecord);
    if (!owner) {
      throw new UnprocessableEntityException(
        "This agent's owner is no longer an active member of this workspace",
      );
    }

    return this.dispatchRun({
      workspaceId: input.workspaceId,
      agentsDb,
      runsDb,
      agentRecord,
      trigger: 'Automation',
      inputRecordId: input.inputRecordId,
      owner,
      // Unattended, same as state-change dispatch: retry a transient failure
      // twice with backoff before the Run lands as the dead-letter.
      retries: 2,
      depth: input.depth ?? 0,
      promptOverride: input.prompt,
      guardrails: {
        scopeCap: input.toolScope,
        maxSteps: input.maxSteps,
        maxCostCents: input.maxCostCents,
        dryRun: input.dryRun,
      },
    });
  }

  /**
   * The one path that turns "run this agent" into a Run record (#208, #212).
   *
   * Manual runs and state-change dispatch share it deliberately: the run-class
   * stamp (ADR-0010 §3), the least-privilege principal (§2) and the
   * failure-lands-in-the-Run contract are exactly the invariants that must not
   * fork per trigger. It takes a bare `workspaceId` + owner rather than a
   * Membership because a domain event carries no membership (#212).
   *
   * It deliberately does NOT check `Enabled` — the two callers want different
   * answers for a disabled agent (manual: 422; dispatch: silently skip).
   */
  async dispatchRun(input: DispatchRunInput): Promise<ProjectedRecord> {
    const { workspaceId, agentsDb, runsDb, agentRecord, trigger, owner } = input;

    // Scopes are stored as multi_select option ids; the principal reasons in labels.
    const scopeLabels = await this.optionLabelsById(agentsDb.id, 'scopes');
    const declaredScopes = ((agentRecord.values['scopes'] as string[] | undefined) ?? [])
      .map((id) => scopeLabels.get(id))
      .filter((label): label is string => Boolean(label));

    // #210 / ADR-0010 §4: the owner's gate list, read off the agent record.
    // multi_select stores option ids, so it is resolved to labels the same way
    // scopes are — the policy is compared against a step's `action.kind`.
    const policyLabels = await this.optionLabelsById(agentsDb.id, 'approval_policy');
    const approvalPolicy = new Set(
      ((agentRecord.values['approval_policy'] as string[] | undefined) ?? [])
        .map((id) => policyLabels.get(id))
        .filter((label): label is string => Boolean(label)),
    );

    // MN-109 Phase A: a guardrail-supplied tool_scope further caps what the
    // agent declared for THIS run only — intersection, never union, so it can
    // only narrow (ADR-0010 §2 still holds: the ceiling is owner ∩ agent ∩ this).
    const scopeCeiling = input.guardrails?.scopeCap;
    const effectiveScopes = scopeCeiling
      ? declaredScopes.filter((s) => scopeCeiling.includes(s))
      : declaredScopes;

    // #207 / ADR-0010 §2: the run acts as its owner, capped by what the agent declares.
    const principal = deriveAgentPrincipal(owner.userId, owner.scope, effectiveScopes);

    // #205 item 1: the owner's own driver choice, read the same way scopes and
    // approval_policy are — a select stores an option id, resolved to its
    // label, then mapped back to the RunClass pickRuntime switches on. Missing
    // entirely (unset field, or a pre-#205 Agents database that hasn't been
    // re-ensured yet) falls through to undefined, which pickRuntime treats as
    // non_ai — the behavior every agent has always had.
    const aiModeLabels = await this.optionLabelsById(agentsDb.id, 'ai_mode');
    const aiModeLabel = aiModeLabels.get(
      (agentRecord.values['ai_mode'] as string | undefined) ?? '',
    );
    const aiMode = aiModeLabel ? RUN_CLASS_BY_LABEL[aiModeLabel] : undefined;

    const agent: AgentRunAgent = {
      id: agentRecord.id,
      name: agentRecord.title,
      // MN-109 Phase A: a run_agent action's `prompt` overrides the agent's
      // own Goal for this run only. Otherwise use the agent's stored Goal.
      // rich_text fields store BlockNote documents — flattened to plain text so
      // a runtime (and, for BYO-AI, an external AI client reading the handoff)
      // gets the same goal/instructions a person reading the record would.
      goal:
        input.promptOverride ??
        (agentRecord.values['goal'] ? blocksToMarkdown(agentRecord.values['goal']) : undefined),
      instructions: agentRecord.values['instructions']
        ? blocksToMarkdown(agentRecord.values['instructions'])
        : undefined,
      scopes: effectiveScopes,
      targetDatabases: (agentRecord.values['target_databases'] as string | undefined) ?? undefined,
      aiMode,
    };

    // ── Dispatch ──────────────────────────────────────────────────────────────
    // CRITICAL (ADR-0010 §3): the runtime — and therefore the run class — is
    // decided HERE, before a single step executes, and stamped on the Run record
    // at creation. Classification can never drift as a consequence of what the
    // run does, which is what makes "your own AI is never metered" provable.
    // This holds for state-change dispatch exactly as it does for manual runs.
    const runtime = this.runtimeFor(agent);
    const runClassLabel = RUN_CLASS_LABEL[runtime.runClass];

    // #205 item 1: the real precondition a your_own_ai run's step log reports
    // on (YourOwnAiRuntime). Only queried for that runtime — every other run
    // class has no use for it, so it never costs them a query.
    const aiConnected =
      runtime.runClass === 'your_own_ai' ? await this.hasLiveApiToken(workspaceId) : false;

    const triggerIds = await this.optionIdsByLabel(runsDb.id, 'trigger');
    const statusIds = await this.optionIdsByLabel(runsDb.id, 'status');
    const runClassIds = await this.optionIdsByLabel(runsDb.id, 'run_class');
    const actorId = owner.userId;

    // MN-168: gate BEFORE execution, same moment as classification. Only
    // non_ai runs are ever checked or counted — your_own_ai/storyos_ai have no
    // call site into EntitlementsService at all (MN-188's structural proof).
    // A blocked run still becomes a real, visible Run record (graceful
    // degradation, never a silent no-op) — it just never invokes the runtime.
    const overAllowance =
      runtime.runClass === 'non_ai' &&
      !(await this.entitlements.can(workspaceId, 'automation_run'));

    // MN-109 Phase A cost-cap guardrail: refuse to even start a run whose
    // classified cost is already known to exceed the configured ceiling.
    // Today only 'storyos_ai' runs have a known cost (the flat MN-214r
    // placeholder) — non_ai/your_own_ai runs have nothing to compare a cap
    // against yet, so the guardrail is a no-op for them rather than a false
    // block.
    const costCapExceeded =
      runtime.runClass === 'storyos_ai' &&
      input.guardrails?.maxCostCents !== undefined &&
      STORYOS_AI_RUN_PLACEHOLDER_COST_CENTS * AI_CREDIT_MARKUP_MULTIPLIER >
        input.guardrails.maxCostCents;

    const blockedBeforeExecution = overAllowance || costCapExceeded;

    let run = await this.recordsService.create(
      workspaceId,
      runsDb.id,
      {
        name: `${agent.name} — ${trigger}`,
        trigger: triggerIds.get(trigger) ?? null,
        status: statusIds.get(blockedBeforeExecution ? 'Failed' : 'Running') ?? null,
        run_class: runClassIds.get(runClassLabel) ?? null,
        started_at: new Date().toISOString(),
        ...(blockedBeforeExecution
          ? {
              finished_at: new Date().toISOString(),
              steps: markdownToBlocks(
                overAllowance
                  ? '- **entitlements.blocked** — Plan automation-run allowance reached for this month'
                  : `- **guardrail.cost_cap** — Estimated run cost exceeds the configured max_cost_cents (${input.guardrails?.maxCostCents})`,
              ),
            }
          : {}),
        // The record that triggered the run — the agent's context (ADR-0010 §5).
        // Text, not a relation: the input record can live in any database.
        input_record: input.inputRecordId ?? null,
        // MN-080: the link is written with the record, so a Run is never
        // briefly unattributed.
        agent: [agentRecord.id],
      },
      actorId,
      // Run lineage: an agent's own writes inherit the triggering event's depth,
      // so a write-back that re-triggers is bounded by the max-depth counter.
      input.depth ?? 0,
    );
    if (blockedBeforeExecution) return run;

    // ── Execute ───────────────────────────────────────────────────────────────
    // A runtime failure is a *run* outcome, not a request failure: it lands in
    // the Run record as Failed with the error in the step log, and the caller
    // still gets 200 + the run to inspect. For state-change dispatch that Run IS
    // the dead-letter (ADR-0010 §5) — visible where the user already looks.
    const attempts = (input.retries ?? 0) + 1;
    const steps: AgentStep[] = [];
    let failure: string | null = null;
    let staged: ProposedAction | null = null;
    let backoffMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptSteps: AgentStep[] = [];
      failure = null;
      try {
        for await (const step of runtime.execute({
          workspaceId,
          agent,
          principal,
          inputRecordId: input.inputRecordId,
          aiConnected,
        })) {
          attemptSteps.push(step);

          // MN-109 Phase A step-cap guardrail: stop dead rather than let an
          // unbounded loop run forever. Treated as a run failure (not a silent
          // truncation) so it is loud where the owner will actually look.
          if (input.guardrails?.maxSteps && attemptSteps.length > input.guardrails.maxSteps) {
            failure = `guardrail: exceeded max_steps (${input.guardrails.maxSteps})`;
            break;
          }

          if (!step.action) continue;
          const kind = step.action.kind;

          // MN-109 Phase A dry-run guardrail: never apply anything for real —
          // log what WOULD have happened and keep going. Takes priority over
          // the approval gate below: a preview has nothing to ask approval for.
          if (input.guardrails?.dryRun) {
            attemptSteps.push({
              tool: 'action.dry_run',
              summary: `Would apply (${kind}): ${step.action.summary}`,
              detail: 'dry_run guardrail — nothing was applied',
            });
            continue;
          }

          // MN-109 Phase A allowed-action guardrail: an action kind outside the
          // configured allowlist is treated exactly like an owner-gated one —
          // staged for approval rather than refused outright, so a narrower
          // run_agent action can still make forward progress under supervision.
          const blockedByAllowlist = Boolean(
            input.guardrails?.allowedActionKinds &&
            !input.guardrails.allowedActionKinds.includes(kind),
          );

          // ── The gate (ADR-0010 §4) ──────────────────────────────────────────
          // The one place a proposal becomes a fact. A step carrying an action
          // whose kind the owner gated is STAGED — written down, never run — and
          // the run stops dead here. Everything else the trust layer promises is
          // downstream of this: reject can guarantee "no side effects" only
          // because nothing was ever applied, and undo is possible only because
          // the apply happens later, under a human's say-so.
          if (approvalPolicy.has(kind) || blockedByAllowlist) {
            staged = step.action;
            // `break` inside for-await calls the generator's .return(), so the
            // runtime is disposed and its remaining steps never execute. Halting
            // has to be real: a gated action that the run "asks about" and then
            // carries on past would be theatre, not a seatbelt.
            break;
          }
          // Ungated: the owner did not ask to be consulted about this class, so
          // it applies inline and the run continues. A failure here is a run
          // failure like any other — it falls through to the catch below.
          attemptSteps.push(
            await this.applyProposedAction(
              workspaceId,
              step.action,
              owner.userId,
              input.depth ?? 0,
            ),
          );
        }
        steps.push(...attemptSteps);
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // Steps from the failed attempt are kept: half a run is still evidence.
        steps.push(...attemptSteps);
        if (attempt < attempts) {
          steps.push({
            tool: 'runtime.retry',
            summary: `Attempt ${attempt} failed: ${failure} — retrying in ${backoffMs}ms`,
          });
          await delay(backoffMs);
          backoffMs *= 2; // exponential backoff (ADR-0010 §5)
        }
      }
    }

    // ── Staged: park the run and ask ──────────────────────────────────────────
    // The action is persisted as data, the run parks in Waiting approval, and
    // the owner is asked in the Inbox with the exact proposal in front of them.
    // Nothing has been applied — approve/reject decides whether it ever is.
    if (staged) {
      const waiting = await this.recordsService.update(
        workspaceId,
        runsDb.id,
        run.id,
        {
          status: statusIds.get('Waiting approval') ?? null,
          steps: markdownToBlocks(stepsToMarkdown(steps)),
          pending_action: JSON.stringify({ action: staged, steps } satisfies StagedAction),
          // Deliberately no `finished_at`: the run isn't finished, it's blocked.
        },
        actorId,
      );

      await this.notifications.notify({
        workspaceId,
        databaseId: runsDb.id,
        recordId: run.id,
        actorId,
        type: 'approval_requested',
        recipients: [owner.userId],
        // The EXACT proposed action (ADR-0010 §4) — an approval you can't read
        // is not an approval. The kind is spelled out too, so the owner can see
        // which of their gates caught this.
        snippet: `${agent.name} wants to ${staged.summary} — approve or reject (${staged.kind})`,
        // The run acts as the agent, not as the person who pressed Run, so the
        // owner must be asked even when they are that person (#210).
        allowSelf: true,
      });
      return waiting;
    }

    const log = failure
      ? `${steps.length ? `${stepsToMarkdown(steps)}\n` : ''}- **error** — Run failed: ${failure}`
      : stepsToMarkdown(steps);

    run = await this.recordsService.update(
      workspaceId,
      runsDb.id,
      run.id,
      {
        status: statusIds.get(failure ? 'Failed' : 'Succeeded') ?? null,
        finished_at: new Date().toISOString(),
        steps: markdownToBlocks(log),
      },
      actorId,
    );
    // MN-168: count only a run that actually succeeded and was classified
    // non_ai — mirrors automations.service.ts's choice not to charge the
    // allowance for a run that errored out before doing anything useful.
    if (!failure && runtime.runClass === 'non_ai')
      await this.entitlements.recordNonAiRun(workspaceId);
    // MN-188: the storyos_ai mirror of the above — only a run that actually
    // succeeded is charged. A run that errored out cost nothing worth billing.
    if (!failure && runtime.runClass === 'storyos_ai') {
      run = await this.chargeStoryOsAiRun(workspaceId, runsDb.id, run, actorId);
    }
    return run;
  }

  /**
   * Run an agent by hand (#208, ADR-0010 §3).
   *
   * The manual run is the whole point of the runtime seam: it works with no LLM
   * at all, so the data model, the least-privilege principal and the run-class
   * stamp are shippable and dogfoodable before any managed runtime exists.
   */
  async run(membership: Membership, agentRef: string): Promise<ProjectedRecord> {
    // Idempotent, and it back-fills Runs/Agent Triggers for older workspaces.
    const { agentsDb, runsDb } = await this.ensurePack(membership);
    const agentRecord = await this.resolveAgent(agentsDb.id, agentRef);

    // A disabled agent is a definition, not a runnable thing. An unset checkbox
    // is not enabled either — least privilege beats convenience here.
    if (agentRecord.values['enabled'] !== true) {
      throw new UnprocessableEntityException(
        'This agent is disabled — enable it before running it',
      );
    }

    return this.dispatchRun({
      workspaceId: membership.workspaceId,
      agentsDb,
      runsDb,
      agentRecord,
      trigger: 'Manual',
      owner: { userId: membership.userId, scope: scopeForRole(membership.role) },
      // No retry on the manual path: a person is watching, and the failure IS
      // the answer they asked for. Retry belongs to unattended dispatch (#212).
      retries: 0,
    });
  }

  // ── Delegate to agent (#44, the flagship integrations-directory card) ──────

  /**
   * "Delegate to agent" on a record: a manual run exactly like `run()` above,
   * except the record the admin was looking at becomes the run's context
   * (`inputRecordId`), and once the run finishes — succeeded, failed, or
   * parked waiting for approval — a comment is posted back on THAT record
   * (not just the Run) linking to the Run so its full step log is one click
   * away. That comment-back is the whole feature: everything else here is
   * `run()`'s existing dispatch path with a record attached.
   *
   * Deliberately the minimal version of "mention/assign the agent on a
   * record": no new @mention affordance in the comment composer, no chat
   * surface (#39) or skills catalog (#40) — just the smallest path from
   * "pick an agent for this record" to "it worked and told me here", so the
   * integrations-directory card is real rather than a mockup. A richer
   * assign-by-@mention UX can replace this call site later without changing
   * what it calls.
   */
  async delegate(
    membership: Membership,
    agentRef: string,
    recordId: string,
  ): Promise<ProjectedRecord> {
    const { agentsDb, runsDb } = await this.ensurePack(membership);
    const agentRecord = await this.resolveAgent(agentsDb.id, agentRef);

    if (agentRecord.values['enabled'] !== true) {
      throw new UnprocessableEntityException(
        'This agent is disabled — enable it before delegating to it',
      );
    }
    await this.requireLiveRecord(membership.workspaceId, recordId);

    const run = await this.dispatchRun({
      workspaceId: membership.workspaceId,
      agentsDb,
      runsDb,
      agentRecord,
      trigger: 'Manual',
      inputRecordId: recordId,
      owner: { userId: membership.userId, scope: scopeForRole(membership.role) },
      retries: 0,
    });

    await this.postDelegationComment(
      membership.workspaceId,
      runsDb.id,
      run,
      agentRecord.title,
      recordId,
      membership.userId,
    );
    return run;
  }

  /** A record must exist, undeleted, in THIS workspace — same check comments.service.ts's #record mentions use. */
  private async requireLiveRecord(workspaceId: string, recordId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: recordsTable.id })
      .from(recordsTable)
      .innerJoin(databasesTable, eq(databasesTable.id, recordsTable.databaseId))
      .where(
        and(
          eq(recordsTable.id, recordId),
          eq(databasesTable.workspaceId, workspaceId),
          isNull(recordsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Record not found in this workspace');
  }

  /**
   * The "posts progress back to the record" half of delegate(). Best-effort —
   * mirrors every other notify()-style producer in this file: a run that
   * finished is the result the admin asked for, and a failure to comment
   * about it must never turn that into a failed request.
   *
   * The comment carries a `record` segment pointing at the Run itself, so its
   * full step log renders as a navigable chip rather than being flattened
   * into comment text (the Run's `Steps` field is a rendered BlockNote
   * document — round-tripping it to plain text here would be lossy, the same
   * reasoning `StagedAction` above documents for `Pending action`).
   */
  private async postDelegationComment(
    workspaceId: string,
    runsDbId: string,
    run: ProjectedRecord,
    agentName: string,
    recordId: string,
    actorId: string,
  ): Promise<void> {
    const statusLabels = await this.optionLabelsById(runsDbId, 'status');
    const status = statusLabels.get(run.values['status'] as string) ?? 'done';
    const body: CommentSegment[] = [
      { type: 'text', text: `🤖 Delegated to ${agentName} — ${status}. ` },
      { type: 'record', record_id: run.id, database_id: runsDbId },
    ];
    await this.comments.create(workspaceId, recordId, body, actorId).catch(() => undefined);
  }

  // ── Approval gates (#210, ADR-0010 §4) ──────────────────────────────────────

  /**
   * Apply a proposed action for real, and describe what happened as a step.
   *
   * The ONLY place a ProposedAction stops being data. Both callers route through
   * it — the ungated inline path and approve — so "applied" means exactly one
   * thing regardless of whether a human was consulted.
   *
   * It executes nothing itself: `automation_action` hands off to the shared
   * AutomationActionsService (MN-046/MN-047 — the same executor buttons and
   * automations use, so agents inherit its validation, token resolution and
   * loop-guard depth), and `record_delete` is the records service's soft delete.
   */
  private async applyProposedAction(
    workspaceId: string,
    action: ProposedAction,
    actorId: string,
    depth: number,
  ): Promise<AgentStep> {
    // The payload crosses two untyped boundaries — an arbitrary runtime made it,
    // and it may have been round-tripped through `Pending action` JSON — so it is
    // validated here, at the apply boundary, rather than trusted at either end.
    const parsed = proposedActionPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `Cannot apply this ${action.kind} action — its payload is malformed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    const payload = parsed.data;

    if (payload.apply === 'record_delete') {
      await this.recordsService.softDelete(
        workspaceId,
        payload.database_id,
        payload.record_id,
        actorId,
      );
      return {
        tool: 'action.applied',
        summary: `Applied (${action.kind}): ${action.summary}`,
        // Undo (ADR-0010 §4): the delete is soft (ADR-0009), so this is
        // recoverable — but only if the run view knows WHICH record to offer
        // back. The id is the whole undo affordance, so it goes in the log.
        detail:
          `Soft-deleted record ${payload.record_id} in database ${payload.database_id}. ` +
          `Undo: POST /workspaces/{ws}/databases/${payload.database_id}/records/${payload.record_id}/restore`,
      };
    }

    const record = await this.recordsService.get(payload.database_id, payload.record_id);
    const effects = await this.actions.execute([payload.action], {
      workspaceId,
      databaseId: payload.database_id,
      record,
      actorId,
      depth,
    });
    return {
      tool: 'action.applied',
      summary: `Applied (${action.kind}): ${action.summary}`,
      detail: effects.map((e) => e.summary).join('; ') || undefined,
    };
  }

  /** Resolve a Run record by uuid or public number, like resolveAgent. */
  private async resolveRun(runsDbId: string, ref: string): Promise<ProjectedRecord> {
    if (UUID_RE.test(ref)) return this.recordsService.get(runsDbId, ref);
    const number = Number(ref);
    if (!Number.isInteger(number) || number <= 0) throw new NotFoundException('Run not found');
    return this.recordsService.getByNumber(runsDbId, number);
  }

  /**
   * The shared half of approve/reject: both resolve the same run, insist on the
   * same state, close the gate the same way, and differ only in whether they
   * apply. Forking that would be how the two verdicts drift out of sync.
   */
  private async resolveGate(
    membership: Membership,
    runRef: string,
    verdict: 'approve' | 'reject',
  ): Promise<ProjectedRecord> {
    const { runsDb } = await this.ensurePack(membership);
    const run = await this.resolveRun(runsDb.id, runRef);

    const statusIds = await this.optionIdsByLabel(runsDb.id, 'status');
    const waitingId = statusIds.get('Waiting approval');
    // Only a parked run has a gate to resolve. Approving a Succeeded run would
    // re-apply its action; approving a Failed one would apply an action its run
    // never reached. Both are 422, not 404 — the run exists, its state is wrong.
    if (!waitingId || run.values['status'] !== waitingId) {
      throw new UnprocessableEntityException('This run is not waiting for approval');
    }

    const staged = parseStaged(run.values['pending_action']);
    if (!staged) {
      throw new UnprocessableEntityException(
        'This run is waiting for approval but has no staged action to resolve',
      );
    }

    const actorId = membership.userId;
    const steps = [...staged.steps];

    if (verdict === 'approve') {
      // NOW the action happens — the first and only time. If applying throws, the
      // run stays parked and the gate stays open: the caller gets the error and
      // can retry, rather than the run being marked Succeeded over a no-op.
      steps.push(await this.applyProposedAction(membership.workspaceId, staged.action, actorId, 0));
    } else {
      // Reject applies NOTHING. There is no rollback here and there is nothing to
      // roll back — the action never left the `Pending action` blob. That is the
      // whole payoff of staging (ADR-0010 §4).
      steps.push({
        tool: 'action.rejected',
        summary: `Rejected (${staged.action.kind}): ${staged.action.summary}`,
        detail: 'The proposed action was not applied. The run was canceled with no side effects.',
      });
    }

    let resolved = await this.recordsService.update(
      membership.workspaceId,
      runsDb.id,
      run.id,
      {
        status: statusIds.get(verdict === 'approve' ? 'Succeeded' : 'Canceled') ?? null,
        finished_at: new Date().toISOString(),
        steps: markdownToBlocks(stepsToMarkdown(steps)),
        // The gate is closed. Clearing this is what stops a second approve from
        // applying the action twice — the state check above then reads Succeeded,
        // and there is no payload left to replay either way.
        pending_action: null,
      },
      actorId,
    );

    // MN-168/MN-188: an approved run only truly succeeds now, so this is where
    // a staged non_ai run counts, or a staged storyos_ai run is charged — not
    // at staging time. run_class was already stamped at dispatch (before this
    // gate ever existed), so this only reads it back; it never re-classifies.
    if (verdict === 'approve') {
      const runClassIds = await this.optionIdsByLabel(runsDb.id, 'run_class');
      if (run.values['run_class'] === runClassIds.get('Non-AI')) {
        await this.entitlements.recordNonAiRun(membership.workspaceId);
      } else if (run.values['run_class'] === runClassIds.get('StoryOS AI')) {
        resolved = await this.chargeStoryOsAiRun(
          membership.workspaceId,
          runsDb.id,
          resolved,
          actorId,
        );
      }
    }
    return resolved;
  }

  /** Approve a parked run: apply the staged action, then Succeed it (#210). */
  async approveRun(membership: Membership, runRef: string): Promise<ProjectedRecord> {
    return this.resolveGate(membership, runRef, 'approve');
  }

  /** Reject a parked run: apply nothing, Cancel it (#210). */
  async rejectRun(membership: Membership, runRef: string): Promise<ProjectedRecord> {
    return this.resolveGate(membership, runRef, 'reject');
  }

  /**
   * Superadmin kill-switch (#300, MN-216c) — cancel a run in ANY workspace,
   * not just one the caller belongs to. This is the one piece #158/MN-216 was
   * still missing (see #300's own split note): every other run mutation
   * above is workspace-scoped, membership-gated. This one is neither — the
   * caller is AdminController, already behind PlatformAdminGuard, reaching
   * across workspaces by design.
   *
   * A pure status flip to Canceled, same status-id lookup as resolveGate
   * above — nothing else changes. Deliberately does NOT run reject's "apply
   * nothing" step-log entry and does NOT clear `pending_action`: this is an
   * operator stopping a runaway/abusive run from outside the workspace, not
   * its owner resolving their own gate, and the ticket is explicit that this
   * is a status flip, not a mutation of what the run already applied. Leaving
   * `pending_action` untouched is still safe: resolveGate's own guard only
   * resolves a run whose status IS "Waiting approval", so a Canceled run can
   * never be approved/rejected afterward and double-apply its staged action.
   */
  async adminCancelRun(
    workspaceId: string,
    runRef: string,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const { runsDb } = await this.findPackDbs(workspaceId);
    if (!runsDb) throw new NotFoundException('This workspace has no Runs database');
    const run = await this.resolveRun(runsDb.id, runRef);

    const statusIds = await this.optionIdsByLabel(runsDb.id, 'status');
    const cancelableIds = new Set(
      ['Queued', 'Running', 'Waiting approval']
        .map((label) => statusIds.get(label))
        .filter((id): id is string => Boolean(id)),
    );
    const currentStatus = run.values['status'];
    if (typeof currentStatus !== 'string' || !cancelableIds.has(currentStatus)) {
      throw new UnprocessableEntityException(
        'This run is not queued, running, or waiting for approval — it cannot be canceled',
      );
    }

    return this.recordsService.update(
      workspaceId,
      runsDb.id,
      run.id,
      { status: statusIds.get('Canceled') ?? null },
      actorId,
    );
  }

  // ── Trigger bindings (#211, ADR-0010 §5) ────────────────────────────────────

  /**
   * Validate a `(database, state, agent)` binding against live schema.
   *
   * The binding stores ids as text (databases and their fields aren't records),
   * so nothing else would catch a state field on the wrong database, a field
   * that isn't a select, or an option lifted from a different field. Without
   * this the dispatcher would simply never fire and the user would have no idea
   * why — so it is a 422 at create time, not a silent no-op at dispatch time.
   */
  async validateBinding(
    workspaceId: string,
    binding: { database_id: string; state_field_id: string; state_option_id: string },
  ) {
    const database = await this.db.query.databases.findFirst({
      where: and(
        eq(databasesTable.id, binding.database_id),
        eq(databasesTable.workspaceId, workspaceId),
      ),
    });
    if (!database) {
      throw new UnprocessableEntityException('That database does not exist in this workspace');
    }

    const field = await this.db.query.fields.findFirst({
      where: and(
        eq(fieldsTable.id, binding.state_field_id),
        eq(fieldsTable.databaseId, binding.database_id),
      ),
    });
    if (!field) {
      throw new UnprocessableEntityException(
        `That state field does not exist on "${database.name}"`,
      );
    }
    // A state is a select — that is what makes "entering a state" a discrete,
    // observable transition rather than an arbitrary value change.
    if (field.type !== 'select') {
      throw new UnprocessableEntityException(
        `A state field must be a select field — "${field.displayName}" is ${field.type}`,
      );
    }

    const option = await this.db.query.selectOptions.findFirst({
      where: and(
        eq(selectOptions.id, binding.state_option_id),
        eq(selectOptions.fieldId, field.id),
      ),
    });
    if (!option) {
      throw new UnprocessableEntityException(
        `That state option does not belong to "${field.displayName}"`,
      );
    }

    return { database, field, option };
  }

  /**
   * Create a binding record after validating it (#211).
   *
   * Only *create* is a bespoke endpoint, and only because validation has to
   * happen somewhere. List/read/update/remove go through the normal records API
   * on the Agent Triggers database — record CRUD is not duplicated here.
   */
  async createBinding(
    membership: Membership,
    input: {
      agent: string;
      database_id: string;
      state_field_id: string;
      state_option_id: string;
      human_gate?: boolean;
      enabled?: boolean;
    },
  ): Promise<ProjectedRecord> {
    const { agentsDb, triggersDb } = await this.ensurePack(membership);
    const agentRecord = await this.resolveAgent(agentsDb.id, input.agent);
    const { database, field, option } = await this.validateBinding(membership.workspaceId, input);

    return this.recordsService.create(
      membership.workspaceId,
      triggersDb.id,
      {
        name: `${agentRecord.title} ← ${database.name}.${field.displayName} = ${option.label}`,
        agent: [agentRecord.id],
        database: input.database_id,
        state_field: input.state_field_id,
        state_option: input.state_option_id,
        human_gate: input.human_gate ?? false,
        // A binding you just created is one you meant to arm.
        enabled: input.enabled ?? true,
      },
      membership.userId,
      0,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
