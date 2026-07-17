import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { markdownToBlocks } from '@storyos/schemas';
import type { TokenScope } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable, selectOptions } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import type { ProjectedRecord } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { deriveAgentPrincipal, scopeForRole } from './agent-principal';
import { pickRuntime, RUN_CLASS_LABEL, stepsToMarkdown } from './agent-runtime';
import type { AgentRuntime, AgentRunAgent, AgentStep } from './agent-runtime';

type Database = typeof databasesTable.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Base backoff between run-execution retries; doubles per attempt (#212). */
const DEFAULT_RETRY_DELAY_MS = 50;

/** The Run record's "Trigger" select labels — how a run came to be. */
export type RunTrigger = 'Manual' | 'State change' | 'Schedule';

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
export class AgentsService {
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
  ) {}

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

  /** label → option id for a select/multi_select field, for writing values. */
  private async optionIdsByLabel(databaseId: string, apiName: string): Promise<Map<string, string>> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    const options = field
      ? await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, field.id) })
      : [];
    return new Map(options.map((o) => [o.label, o.id]));
  }

  /** option id → label, for reading multi_select values back off a record. */
  private async optionLabelsById(databaseId: string, apiName: string): Promise<Map<string, string>> {
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
          // state/schedule runtimes exist (ADR-0010 §3).
          options: [
            { label: 'Manual', color: 'gray' },
            { label: 'State change', color: 'green' },
            { label: 'Schedule', color: 'purple' },
          ],
        },
        // TODO(#206): a relation to "databases" isn't possible while databases
        // aren't records, so target databases are stored as text (names/ids) for
        // now. Replace with a richer target-picker once databases are addressable.
        { display_name: 'Target databases', type: 'text', config: {} },
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

  /** Resolve an agent record by uuid or public number (MN-087 pretty handles). */
  private async resolveAgent(agentsDbId: string, ref: string): Promise<ProjectedRecord> {
    if (UUID_RE.test(ref)) return this.recordsService.get(agentsDbId, ref);
    const number = Number(ref);
    if (!Number.isInteger(number) || number <= 0) throw new NotFoundException('Agent not found');
    return this.recordsService.getByNumber(agentsDbId, number);
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

    // #207 / ADR-0010 §2: the run acts as its owner, capped by what the agent declares.
    const principal = deriveAgentPrincipal(owner.userId, owner.scope, declaredScopes);

    const agent: AgentRunAgent = {
      id: agentRecord.id,
      name: agentRecord.title,
      scopes: declaredScopes,
      targetDatabases: (agentRecord.values['target_databases'] as string | undefined) ?? undefined,
    };

    // ── Dispatch ──────────────────────────────────────────────────────────────
    // CRITICAL (ADR-0010 §3): the runtime — and therefore the run class — is
    // decided HERE, before a single step executes, and stamped on the Run record
    // at creation. Classification can never drift as a consequence of what the
    // run does, which is what makes "your own AI is never metered" provable.
    // This holds for state-change dispatch exactly as it does for manual runs.
    const runtime = this.runtimeFor(agent);
    const runClassLabel = RUN_CLASS_LABEL[runtime.runClass];

    const triggerIds = await this.optionIdsByLabel(runsDb.id, 'trigger');
    const statusIds = await this.optionIdsByLabel(runsDb.id, 'status');
    const runClassIds = await this.optionIdsByLabel(runsDb.id, 'run_class');
    const actorId = owner.userId;

    let run = await this.recordsService.create(
      workspaceId,
      runsDb.id,
      {
        name: `${agent.name} — ${trigger}`,
        trigger: triggerIds.get(trigger) ?? null,
        status: statusIds.get('Running') ?? null,
        run_class: runClassIds.get(runClassLabel) ?? null,
        started_at: new Date().toISOString(),
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

    // ── Execute ───────────────────────────────────────────────────────────────
    // A runtime failure is a *run* outcome, not a request failure: it lands in
    // the Run record as Failed with the error in the step log, and the caller
    // still gets 200 + the run to inspect. For state-change dispatch that Run IS
    // the dead-letter (ADR-0010 §5) — visible where the user already looks.
    const attempts = (input.retries ?? 0) + 1;
    const steps: AgentStep[] = [];
    let failure: string | null = null;
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
        })) {
          attemptSteps.push(step);
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
      throw new UnprocessableEntityException('This agent is disabled — enable it before running it');
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
