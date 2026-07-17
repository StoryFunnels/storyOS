import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { markdownToBlocks } from '@storyos/schemas';
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

  /** The pack's databases, as far as they have been provisioned. */
  private async findPackDbs(workspaceId: string) {
    const all = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, workspaceId),
    });
    return {
      agentsDb: all.find((d) => d.name === 'Agents'),
      runsDb: all.find((d) => d.name === 'Runs'),
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
  ): Promise<{ agentsDb: Database; runsDb: Database; created: boolean }> {
    const existing = await this.findPackDbs(membership.workspaceId);
    if (existing.agentsDb && existing.runsDb) {
      return { agentsDb: existing.agentsDb, runsDb: existing.runsDb, created: false };
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

    return { agentsDb, runsDb, created: true };
  }

  /**
   * Summary of the pack's databases if provisioned, else `{ exists: false }`.
   * Agent and Run records themselves are read/created through the normal records
   * API on these databases — this service does not duplicate record CRUD.
   */
  async getPack(membership: Membership): Promise<
    | { exists: true; id: string; name: string; runs: { id: string; name: string } | null }
    | { exists: false }
  > {
    const { agentsDb, runsDb } = await this.findPackDbs(membership.workspaceId);
    if (!agentsDb) return { exists: false };
    return {
      exists: true,
      id: agentsDb.id,
      name: agentsDb.name,
      // Provisioned separately, so a pre-#209 workspace reports Agents without Runs
      // until its next ensure.
      runs: runsDb ? { id: runsDb.id, name: runsDb.name } : null,
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
   * Run an agent by hand (#208, ADR-0010 §3).
   *
   * The manual run is the whole point of the runtime seam: it works with no LLM
   * at all, so the data model, the least-privilege principal and the run-class
   * stamp are shippable and dogfoodable before any managed runtime exists.
   */
  async run(membership: Membership, agentRef: string): Promise<ProjectedRecord> {
    // Idempotent, and it back-fills Runs for workspaces provisioned before #209.
    const { agentsDb, runsDb } = await this.ensurePack(membership);
    const agentRecord = await this.resolveAgent(agentsDb.id, agentRef);

    // A disabled agent is a definition, not a runnable thing. An unset checkbox
    // is not enabled either — least privilege beats convenience here.
    if (agentRecord.values['enabled'] !== true) {
      throw new UnprocessableEntityException('This agent is disabled — enable it before running it');
    }

    // Scopes are stored as multi_select option ids; the principal reasons in labels.
    const scopeLabels = await this.optionLabelsById(agentsDb.id, 'scopes');
    const declaredScopes = ((agentRecord.values['scopes'] as string[] | undefined) ?? [])
      .map((id) => scopeLabels.get(id))
      .filter((label): label is string => Boolean(label));

    // #207 / ADR-0010 §2: the run acts as its owner, capped by what the agent declares.
    const principal = deriveAgentPrincipal(
      membership.userId,
      scopeForRole(membership.role),
      declaredScopes,
    );

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
    const runtime = this.runtimeFor(agent);
    const runClassLabel = RUN_CLASS_LABEL[runtime.runClass];

    const triggerIds = await this.optionIdsByLabel(runsDb.id, 'trigger');
    const statusIds = await this.optionIdsByLabel(runsDb.id, 'status');
    const runClassIds = await this.optionIdsByLabel(runsDb.id, 'run_class');
    const actorId = membership.userId;

    let run = await this.recordsService.create(
      membership.workspaceId,
      runsDb.id,
      {
        name: `${agent.name} — Manual`,
        trigger: triggerIds.get('Manual') ?? null,
        status: statusIds.get('Running') ?? null,
        run_class: runClassIds.get(runClassLabel) ?? null,
        started_at: new Date().toISOString(),
        // MN-080: the link is written with the record, so a Run is never
        // briefly unattributed.
        agent: [agentRecord.id],
      },
      actorId,
      0,
    );

    // ── Execute ───────────────────────────────────────────────────────────────
    // A runtime failure is a *run* outcome, not a request failure: it lands in
    // the Run record as Failed with the error in the step log, and the caller
    // still gets 200 + the run to inspect.
    const steps: AgentStep[] = [];
    let failure: string | null = null;
    try {
      for await (const step of runtime.execute({
        workspaceId: membership.workspaceId,
        agent,
        principal,
      })) {
        steps.push(step);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const log = failure
      ? `${steps.length ? `${stepsToMarkdown(steps)}\n` : ''}- **error** — Run failed: ${failure}`
      : stepsToMarkdown(steps);

    run = await this.recordsService.update(
      membership.workspaceId,
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
}
