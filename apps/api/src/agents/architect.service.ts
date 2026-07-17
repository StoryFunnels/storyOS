import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { architectPlanSchema, markdownToBlocks } from '@storyos/schemas';
import type { ArchitectBuildResult, ArchitectPlan, PlanField, PlanState } from '@storyos/schemas';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AgentsService } from './agents.service';
import { knownScenarios, pickProposer } from './architect-proposer';
import type { PlanProposer, ProposeContext } from './architect-proposer';

/** How many existing agent/binding records a build scans when deduplicating. */
const MAX_SCAN = 200;

/** A field as `DatabasesService.get` returns it. */
interface LiveField {
  id: string;
  displayName: string;
  apiName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The Architect (#213 propose / #214 build, ADR-0010 §6 —
 * docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * ADR-0010 §6 is emphatic about what this is *not*: "it is not a second engine…
 * It needs no engine privilege the CRUD API does not already expose." So this
 * service holds no schema of its own, touches no drizzle table directly, and
 * owns no bespoke write path. It is a **client** of the same services a person
 * with an HTTP client drives — SpacesService, DatabasesService, FieldsService,
 * RelationsService, RecordsService, and AgentsService.createBinding — which is
 * precisely why everything it builds is ordinary, hand-editable workspace
 * config afterwards. If you can't edit it in the UI, the Architect built it
 * wrong.
 *
 * The split between the halves is the point:
 *
 *   propose (#213) — reads the workspace, emits a plan, **writes nothing**.
 *   build   (#214) — takes an approved plan back and executes it via CRUD.
 *
 * They are two calls with a human in between, not one call with a flag, because
 * the reviewable artefact *is* the deliverable of #213.
 */
@Injectable()
export class ArchitectService {
  /**
   * The planning seam (#213). Swappable in tests and mirrored on
   * `AgentsService.runtimeFor` — see architect-proposer.ts for why the two seams
   * are shaped alike and what the default proposer honestly is (template
   * matching, not language understanding).
   */
  proposerFor: (ctx: ProposeContext) => PlanProposer = pickProposer;

  constructor(
    private readonly spaces: SpacesService,
    private readonly databases: DatabasesService,
    private readonly fields: FieldsService,
    private readonly relations: RelationsService,
    private readonly records: RecordsService,
    private readonly agents: AgentsService,
  ) {}

  // ── #213: propose ───────────────────────────────────────────────────────────

  /**
   * Turn a plain-language goal into a concrete, reviewable plan — and build
   * NOTHING (#213, ADR-0010 §6).
   *
   * "Builds nothing" is the entire reason this is a separate ticket, so it is
   * worth being explicit about how it is achieved rather than merely intended:
   * every call below is a read (`databases.list`), and the proposer is a pure
   * function. In particular this does NOT call `agents.ensurePack()` — that
   * provisions three databases, and calling it here would make the
   * propose-builds-nothing AC false the first time anyone previewed a plan.
   */
  async propose(membership: Membership, goal: string): Promise<ArchitectPlan> {
    const ctx: ProposeContext = { workspaceId: membership.workspaceId, goal };
    const proposer = this.proposerFor(ctx);
    const draft = proposer.propose(ctx);
    if (!draft) {
      throw new UnprocessableEntityException(
        `The Architect has no plan for that goal. It matches goals against a small library of ` +
          `scenario templates (${knownScenarios().join(', ')}) rather than interpreting them — ` +
          `try naming the workflow, e.g. "when a lead arrives, draft a reply and follow up".`,
      );
    }

    // ── create-new vs reuse-existing (the #213 AC) ─────────────────────────────
    // Resolved HERE, against the workspace's live databases, and never by the
    // proposer: whether a "Leads" database already exists is a fact about the
    // workspace, not about the goal. Matching is by name, case-insensitively —
    // the same find-by-name idempotency rule `ensurePack` uses, so the Architect
    // and the pack agree on what "already there" means.
    const live = await this.databases.list(membership);
    const byName = new Map(live.map((d) => [norm(d.name), d]));

    const plan = {
      ...draft,
      databases: draft.databases.map((d) => ({
        ...d,
        action: byName.has(norm(d.name)) ? ('reuse' as const) : ('create' as const),
      })),
    };

    // Parsed on the way out so `propose` and `build` are provably talking about
    // the same shape — a plan that would fail build's validation must never
    // leave propose.
    return architectPlanSchema.parse(plan);
  }

  // ── #214: build ─────────────────────────────────────────────────────────────

  /**
   * Execute an approved plan through the ordinary CRUD services (#214).
   *
   * `rawPlan` is `unknown` on purpose: the plan has been out of the building —
   * shown to a human, possibly hand-edited, round-tripped through JSON — so it
   * is re-validated at this boundary rather than trusted because propose once
   * emitted something like it. (Same reasoning as `applyProposedAction`
   * re-parsing a staged payload in agents.service.ts.)
   *
   * Idempotent wherever that is cheap: everything is found-by-name first, so a
   * re-build of the same plan reuses instead of duplicating.
   */
  async build(membership: Membership, rawPlan: unknown): Promise<ArchitectBuildResult> {
    const parsed = architectPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      // 422, never a 500: a malformed plan is a bad request about a legitimate
      // resource, and the reviewer needs to know *which* part is wrong.
      throw new UnprocessableEntityException(
        `This is not a valid Architect plan: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    const plan = parsed.data;

    const result: ArchitectBuildResult = {
      summary: plan.summary,
      scenario: plan.scenario,
      spaces: [],
      databases: [],
      fields: [],
      relations: [],
      states: [],
      agents: [],
      triggers: [],
    };

    // The pack has to exist before an agent record can: this is the ONE
    // provisioning call, and it belongs to build, not propose.
    const { agentsDb, triggersDb } = await this.agents.ensurePack(membership);

    const dbIds = await this.buildDatabases(membership, plan, result);
    await this.buildRelations(membership, plan, dbIds, result);
    await this.buildStates(membership, plan, dbIds, result);
    const agentIds = await this.buildAgents(membership, plan, agentsDb.id, dbIds, result);
    await this.buildTriggers(membership, plan, dbIds, agentIds, triggersDb.id, result);

    return result;
  }

  // ── build steps ─────────────────────────────────────────────────────────────

  /** Live fields of a database, read through the ordinary introspection route. */
  private async liveFields(membership: Membership, databaseId: string): Promise<LiveField[]> {
    const detail = await this.databases.get(membership, databaseId);
    return detail.fields as unknown as LiveField[];
  }

  private async ensureSpace(
    membership: Membership,
    name: string,
    result: ArchitectBuildResult,
  ): Promise<string> {
    const already = result.spaces.find((s) => norm(s.name) === norm(name));
    if (already) return already.id;

    const all = await this.spaces.list(membership);
    const existing = all.find((s) => norm(s.name) === norm(name));
    if (existing) {
      result.spaces.push({ name, action: 'reused', id: existing.id });
      return existing.id;
    }
    const created = await this.spaces.create(membership.workspaceId, { name });
    result.spaces.push({ name, action: 'created', id: created.id });
    return created.id;
  }

  /** Add a planned field unless one of that display name is already there. */
  private async ensureField(
    membership: Membership,
    databaseId: string,
    dbName: string,
    field: PlanField,
    result: ArchitectBuildResult,
  ): Promise<LiveField> {
    const live = await this.liveFields(membership, databaseId);
    const existing = live.find((f) => norm(f.displayName) === norm(field.name));
    const label = `${dbName}.${field.name}`;
    if (existing) {
      result.fields.push({ name: label, action: 'reused', id: existing.id });
      return existing;
    }
    const created = (await this.fields.create(databaseId, {
      display_name: field.name,
      type: field.type,
      // A plan may carry type config (precision, include_time). The proposer
      // never emits any, but a pack manifest — which is an ArchitectPlan — does,
      // and hardcoding `{}` here silently dropped it.
      config: field.config ?? {},
      options: field.options,
    })) as unknown as LiveField;
    result.fields.push({ name: label, action: 'created', id: created.id });
    return created;
  }

  private async buildDatabases(
    membership: Membership,
    plan: ArchitectPlan,
    result: ArchitectBuildResult,
  ): Promise<Map<string, string>> {
    const live = await this.databases.list(membership);
    const byName = new Map(live.map((d) => [norm(d.name), d]));
    const ids = new Map<string, string>();

    for (const planned of plan.databases) {
      const existing = byName.get(norm(planned.name));

      if (planned.action === 'reuse' && !existing) {
        // The plan was written against a workspace that no longer looks like
        // this — someone deleted or renamed the database between propose and
        // build. Refuse: silently creating it would ignore the very decision the
        // reviewer approved ("reuse my Leads database"), and could scatter data
        // across a second one.
        throw new UnprocessableEntityException(
          `The plan reuses a database named "${planned.name}", but no such database exists in ` +
            `this workspace any more. Re-propose the plan so it can be reviewed against what ` +
            `is actually here.`,
        );
      }

      let databaseId: string;
      if (existing) {
        // Note this covers `action: 'create'` too. A database of that name
        // appearing between propose and build (a parallel build, or someone
        // making it by hand) does not license a duplicate — "reuse, don't
        // duplicate" is an AC, and it is enforced against live state, not
        // against what the plan hoped.
        databaseId = existing.id;
        result.databases.push({ name: planned.name, action: 'reused', id: existing.id });
      } else {
        const spaceId = await this.ensureSpace(membership, planned.space, result);
        const created = await this.databases.create(membership, {
          space_id: spaceId,
          name: planned.name,
        });
        databaseId = created.id;
        result.databases.push({ name: planned.name, action: 'created', id: created.id });
      }
      ids.set(norm(planned.name), databaseId);

      for (const field of planned.fields) {
        await this.ensureField(membership, databaseId, planned.name, field, result);
      }
    }
    return ids;
  }

  /** A database the plan refers to by name, or 422 if the plan never declared it. */
  private resolveDb(ids: Map<string, string>, name: string, what: string): string {
    const id = ids.get(norm(name));
    if (!id) {
      throw new UnprocessableEntityException(
        `${what} refers to a database "${name}" that the plan does not declare.`,
      );
    }
    return id;
  }

  private async buildRelations(
    membership: Membership,
    plan: ArchitectPlan,
    dbIds: Map<string, string>,
    result: ArchitectBuildResult,
  ): Promise<void> {
    for (const planned of plan.relations) {
      const fromId = this.resolveDb(dbIds, planned.from, 'A relation');
      const toId = this.resolveDb(dbIds, planned.to, 'A relation');
      const label = `${planned.from}.${planned.from_field} → ${planned.to}`;

      // A relation is identified by its field on the "many" side. If that field
      // is already there the relation exists — creating it again would 422 on
      // the display-name uniqueness guard anyway, and reuse is the right answer.
      const live = await this.liveFields(membership, fromId);
      const existing = live.find(
        (f) => f.type === 'relation' && norm(f.displayName) === norm(planned.from_field),
      );
      if (existing) {
        result.relations.push({ name: label, action: 'reused', id: existing.id });
        continue;
      }

      const relation = await this.relations.create(membership, {
        database_a_id: fromId,
        database_b_id: toId,
        cardinality: planned.cardinality,
        field_a_name: planned.from_field,
        field_b_name: planned.to_field,
      });
      result.relations.push({ name: label, action: 'created', id: relation.id });
    }
  }

  /**
   * The workflow states: a select field per (database, field), with its options.
   *
   * A state is a select (ADR-0010 §5) — the dispatcher only fires on discrete
   * option transitions — so a same-named field of another type is a hard stop
   * rather than something to work around.
   */
  private async buildStates(
    membership: Membership,
    plan: ArchitectPlan,
    dbIds: Map<string, string>,
    result: ArchitectBuildResult,
  ): Promise<void> {
    for (const planned of plan.states) {
      const databaseId = this.resolveDb(dbIds, planned.database, 'A state');
      const label = `${planned.database}.${planned.field}`;
      const live = await this.liveFields(membership, databaseId);
      const existing = live.find((f) => norm(f.displayName) === norm(planned.field));

      if (!existing) {
        const created = (await this.fields.create(databaseId, {
          display_name: planned.field,
          type: 'select',
          config: {},
          options: planned.options.map((o) => ({ label: o.label, color: o.color })),
        })) as unknown as LiveField;
        result.states.push({ name: label, action: 'created', id: created.id });
        continue;
      }

      if (existing.type !== 'select') {
        throw new UnprocessableEntityException(
          `"${label}" already exists as a ${existing.type} field, but a workflow state must be a ` +
            `select field. Rename or remove it, then build again.`,
        );
      }

      // Reused: add only the states it is missing. Untouched existing options
      // matter — this is somebody's live workflow, and the plan is additive.
      await this.ensureOptions(databaseId, existing, planned);
      result.states.push({ name: label, action: 'reused', id: existing.id });
    }
  }

  private async ensureOptions(
    databaseId: string,
    field: LiveField,
    planned: PlanState,
  ): Promise<void> {
    const have = new Set((field.options ?? []).map((o) => norm(o.label)));
    for (const option of planned.options) {
      if (have.has(norm(option.label))) continue;
      await this.fields.addOption(databaseId, field.id, {
        label: option.label,
        color: option.color ?? 'gray',
      });
    }
  }

  /**
   * The agent records themselves (ADR-0010 §1) — created through the ordinary
   * records API on the Agents database, exactly as a person would create them.
   */
  private async buildAgents(
    membership: Membership,
    plan: ArchitectPlan,
    agentsDbId: string,
    dbIds: Map<string, string>,
    result: ArchitectBuildResult,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (plan.agents.length === 0) return ids;

    const agentFields = await this.liveFields(membership, agentsDbId);
    const optionId = (apiName: string, label: string): string | null =>
      agentFields
        .find((f) => f.apiName === apiName)
        ?.options?.find((o) => o.label === label)?.id ?? null;

    const existingAgents = await this.records.list(agentsDbId, { limit: MAX_SCAN });

    for (const planned of plan.agents) {
      const existing = existingAgents.data.find((r) => norm(r.title) === norm(planned.name));
      if (existing) {
        // An agent of that name is already defined. Its owner may have tuned its
        // scopes or gates by hand since — overwriting that from a template would
        // be the opposite of "ordinary, hand-editable workspace config".
        result.agents.push({ name: planned.name, action: 'reused', id: existing.id });
        ids.set(norm(planned.name), existing.id);
        continue;
      }

      // Every name the plan mentions is a database it declared, so target
      // databases resolve to real ids rather than hopeful strings.
      const targets = planned.target_databases
        .map((name) => dbIds.get(norm(name)))
        .filter((id): id is string => Boolean(id));

      const created = await this.records.create(
        membership.workspaceId,
        agentsDbId,
        {
          name: planned.name,
          goal: markdownToBlocks(planned.goal),
          instructions: planned.instructions ? markdownToBlocks(planned.instructions) : null,
          scopes: planned.scopes
            .map((s) => optionId('scopes', s))
            .filter((id): id is string => Boolean(id)),
          approval_policy: planned.approval_policy
            .map((p) => optionId('approval_policy', p))
            .filter((id): id is string => Boolean(id)),
          target_databases: targets.join(', '),
          // Build happens only after a human approved the plan (ADR-0010 §6), and
          // the plan they approved says what this agent does and what it must ask
          // about. A wired-but-disabled agent would just be a second, invisible
          // approval step — and the gates are where the seatbelt lives, not here.
          enabled: true,
        },
        membership.userId,
        0,
      );
      result.agents.push({ name: planned.name, action: 'created', id: created.id });
      ids.set(norm(planned.name), created.id);
    }
    return ids;
  }

  /**
   * The bindings (ADR-0010 §5), created through `AgentsService.createBinding` —
   * the same validated path the public endpoint uses, so the Architect cannot
   * write a binding a person could not.
   */
  private async buildTriggers(
    membership: Membership,
    plan: ArchitectPlan,
    dbIds: Map<string, string>,
    agentIds: Map<string, string>,
    triggersDbId: string,
    result: ArchitectBuildResult,
  ): Promise<void> {
    if (plan.triggers.length === 0) return;
    const existingBindings = await this.records.list(triggersDbId, { limit: MAX_SCAN });

    for (const planned of plan.triggers) {
      const databaseId = this.resolveDb(dbIds, planned.database, 'A trigger');
      const agentId = agentIds.get(norm(planned.agent));
      if (!agentId) {
        throw new UnprocessableEntityException(
          `A trigger refers to an agent "${planned.agent}" that the plan does not declare.`,
        );
      }

      const live = await this.liveFields(membership, databaseId);
      const field = live.find((f) => norm(f.displayName) === norm(planned.state_field));
      if (!field || field.type !== 'select') {
        throw new UnprocessableEntityException(
          `A trigger binds to "${planned.database}.${planned.state_field}", which is not a select ` +
            `field on that database.`,
        );
      }
      const option = field.options?.find((o) => norm(o.label) === norm(planned.state_option));
      if (!option) {
        throw new UnprocessableEntityException(
          `A trigger binds to the state "${planned.state_option}", which is not an option of ` +
            `"${planned.database}.${planned.state_field}".`,
        );
      }

      const label = `${planned.agent} ← ${planned.database}.${planned.state_field} = ${planned.state_option}`;
      const duplicate = existingBindings.data.find(
        (b) =>
          b.values['database'] === databaseId &&
          b.values['state_field'] === field.id &&
          b.values['state_option'] === option.id &&
          ((b.values['agent'] as Array<{ id: string }> | undefined) ?? []).some(
            (l) => l.id === agentId,
          ),
      );
      if (duplicate) {
        result.triggers.push({ name: label, action: 'reused', id: duplicate.id });
        continue;
      }

      const created = await this.agents.createBinding(membership, {
        agent: agentId,
        database_id: databaseId,
        state_field_id: field.id,
        state_option_id: option.id,
        human_gate: planned.human_gate,
        enabled: true,
      });
      result.triggers.push({ name: label, action: 'created', id: created.id });
    }
  }
}
