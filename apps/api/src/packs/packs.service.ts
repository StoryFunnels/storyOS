import { ConflictException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  compareSemver,
  creatableFieldTypeSchema,
  dbRef,
  fieldRef,
  optionRef,
  packExportRequestSchema,
  packManifestSchema,
} from '@storyos/schemas';
import type {
  PackAgent,
  PackAiNeed,
  PackConnection,
  PackDerivedField,
  PackExportRequest,
  PackInstallResolutions,
  PackInstallResult,
  PackInstallSummary,
  PackManifest,
  PackPreviewItem,
  PackPreviewResult,
  PackSkill,
  PackUninstallResult,
  PackUnmetRequirement,
  PlanAgent,
  PlanDatabase,
  PlanRelation,
  PlanState,
  PlanTrigger,
} from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { packInstallItems, packInstalls, workspaces } from '../db/schema';
import { redactSecrets } from '../common/redact-secrets';
import { AgentsService } from '../agents/agents.service';
import { ArchitectService } from '../agents/architect.service';
import { AutomationsService } from '../automations/automations.service';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SkillsService } from '../skills/skills.service';
import { ViewsService } from '../views/views.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { MarketplaceService } from './marketplace.service';
import { deref, findRawUuids, refify } from './pack-refs';

/** How many records a scan of a system database reads. Mirrors ArchitectService. */
const MAX_SCAN = 200;

const norm = (s: string) => s.trim().toLowerCase();

/** The Agentic OS system databases — provisioned by `ensurePack`, never exported. */
const SYSTEM_DBS = new Set(['agents', 'runs', 'agent triggers']);

/**
 * Field types whose values are portable between workspaces.
 *
 * Relation, user and file values are ids of things a pack does not carry: a
 * link to a record that is not coming along, a person who may not exist in the
 * target workspace, a blob in another workspace's storage. Sample data is meant
 * to make an installed pack legible on first open, and a dangling link does the
 * opposite — so those values are left behind rather than exported as refs that
 * cannot resolve.
 */
const PORTABLE_VALUE_TYPES = new Set([
  'text',
  'rich_text',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'color',
]);

/** Field types whose config points at another field — see `packDerivedFieldSchema`. */
const DERIVED_TYPES = new Set(['lookup', 'rollup', 'button']);

/**
 * The field types a manifest can ask for.
 *
 * Everything else — `id`, `title`, `created_at`, `updated_at`, `created_by` — is
 * provisioned with the database itself, so exporting them would make install try
 * to add a second "Name". Membership of this set, rather than the `is_system`
 * flag, is the test: the title field is *not* flagged system (it is renameable)
 * but is still auto-created, and keying off the flag exported it as a plain
 * field of an uncreatable type.
 */
const CREATABLE_TYPES = new Set<string>(creatableFieldTypeSchema.options);

interface LiveField {
  id: string;
  displayName: string;
  apiName: string;
  type: string;
  isSystem?: boolean;
  config?: Record<string, unknown>;
  options?: Array<{ id: string; label: string; color?: string }>;
}

interface LiveView {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  /** Every database is provisioned with exactly one (`databases.service.ts`'s
   * "All records"), and `ViewsService.remove` refuses to delete a database's
   * last view. It is scaffolding, not pack content — see the doc on
   * `computeCollisions`'s view classification and `installViews`/`uninstall`
   * for why it is never a `collision`, never independently tracked, and never
   * removed. */
  isDefault?: boolean;
}

interface SliceDb {
  id: string;
  name: string;
  space: string;
  fields: LiveField[];
  views: LiveView[];
}

/**
 * Business Packs (MN-218 / #160, ADR-0010 §6).
 *
 * A pack is "install a whole business in one click" made true: schema,
 * relations, views, workflow states with human gates, automations, agents with
 * their state bindings — the running system, not the empty filing cabinet the
 * starter templates ship (#82).
 *
 * ── This service is not an installer ────────────────────────────────────────
 *
 * That is the whole design. `ArchitectService.build` (#214) is already a
 * deterministic, find-by-name, idempotent walk that creates databases, fields,
 * relations, states, agents and bindings through the ordinary CRUD services, and
 * a `PackManifest` **is** an `ArchitectPlan` (see packs.ts). So `install` hands
 * the manifest to `build` unchanged and adds only what the Architect has no
 * concept of: derived fields, views, automations and sample records. There is no
 * second walk, no forked notion of "reuse", and no copy to drift — if the two
 * ever disagreed the manifest would stop type-checking as a plan.
 *
 * Export is the mirror image, and is also the template-authoring path: it reads
 * a slice of a workspace and writes the same manifest shape back out, with every
 * id replaced by a symbolic ref. The two ref tables — export's `id → ref` and
 * install's `ref → id` — are built by the same rules from the same names, which
 * is what makes the round trip closed rather than merely hopeful.
 */
@Injectable()
export class PacksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databases: DatabasesService,
    private readonly fields: FieldsService,
    private readonly relations: RelationsService,
    private readonly records: RecordsService,
    private readonly views: ViewsService,
    private readonly automations: AutomationsService,
    private readonly agents: AgentsService,
    private readonly architect: ArchitectService,
    private readonly skills: SkillsService,
    private readonly marketplace: MarketplaceService,
  ) {}

  // ── export ─────────────────────────────────────────────────────────────────

  /**
   * Export a workspace slice as a pack manifest.
   *
   * Reads only. Every id becomes a symbolic ref, and the result is checked for
   * leaked uuids before it is returned — the AC is "no raw ids in the manifest",
   * so this proves it rather than trusting that the walk covered every path.
   */
  async export(membership: Membership, rawRequest: unknown): Promise<PackManifest> {
    const parsed = packExportRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `Invalid pack export request: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    const request = parsed.data;
    const slice = await this.readSlice(membership, request);

    const idToRef = this.buildExportRefs(slice);
    const { agentsDb, triggersDb } = await this.agents.ensurePack(membership);
    const bindings = await this.records.list(triggersDb.id, { limit: MAX_SCAN });

    // Which selects are workflow states, and which are ordinary columns? A state
    // is a select the workflow *binds to* (ADR-0010 §5: "a state is a select;
    // that is what makes entering a state a discrete, observable transition").
    // Nothing else distinguishes them in the schema, so the bindings decide —
    // guessing by name would be a heuristic pretending to be a fact.
    const stateFieldIds = new Set(
      bindings.data
        .map((b) => b.values['state_field'])
        .filter((id): id is string => typeof id === 'string'),
    );

    const databases: PlanDatabase[] = [];
    const states: PlanState[] = [];
    const derivedFields: PackDerivedField[] = [];

    for (const db of slice) {
      const plain: PlanDatabase['fields'] = [];
      for (const field of db.fields) {
        // Auto-provisioned fields (the title, the id, the audit timestamps) come
        // with the database — see CREATABLE_TYPES. They still carry refs, so a
        // view may group or size by them; they just are not re-created.
        if (!CREATABLE_TYPES.has(field.type)) continue;
        if (field.isSystem) continue;
        if (field.type === 'relation') continue; // emitted under `relations`
        if (DERIVED_TYPES.has(field.type)) {
          derivedFields.push({
            database: db.name,
            name: field.displayName,
            type: field.type as PackDerivedField['type'],
            // A pack is a *shareable artifact* — it gets committed, emailed and
            // published. A button's `send_webhook` action carries an arbitrary
            // `headers` map (where an `Authorization: Bearer …` lives) and a URL
            // that may embed userinfo, so the config is redacted on the way out.
            // The installer re-prompts for credentials; a leaked pack cannot.
            config: refify(
              redactSecrets(field.config ?? {}),
              idToRef,
              `The ${field.type} field "${db.name}.${field.displayName}"`,
            ) as Record<string, unknown>,
          });
          continue;
        }
        if (field.type === 'select' && stateFieldIds.has(field.id)) {
          states.push({
            database: db.name,
            field: field.displayName,
            options: (field.options ?? []).map((o) => ({
              label: o.label,
              color: o.color as PlanState['options'][number]['color'],
            })),
          });
          continue;
        }
        plain.push({
          name: field.displayName,
          type: field.type as PlanDatabase['fields'][number]['type'],
          options: field.options?.map((o) => ({
            label: o.label,
            color: o.color as PlanState['options'][number]['color'],
          })),
          // Configs of plain types carry no refs (precision, multiline,
          // include_time), but they are schema and dropping them would make the
          // round trip lossy in a way nobody notices until a number renders
          // with the wrong precision.
          config: this.plainConfig(field),
        });
      }
      databases.push({ action: 'create', name: db.name, space: db.space, fields: plain });
    }

    const relations = await this.exportRelations(slice);
    const { agents, triggers } = await this.exportAgents(
      membership,
      slice,
      agentsDb.id,
      bindings.data,
    );
    const views = this.exportViews(slice, idToRef);
    const automations = await this.exportAutomations(slice, idToRef);
    const sampleRecords = request.include_sample_records
      ? await this.exportSampleRecords(slice, idToRef, request.sample_limit)
      : [];
    const skills = await this.exportSkills(membership, request.skill_ids);

    const manifest: PackManifest = packManifestSchema.parse({
      format_version: 1,
      slug: request.slug,
      name: request.name,
      version: request.version,
      upgrade_notes: request.upgrade_notes,
      summary: request.summary,
      license: request.license,
      attribution: request.attribution,
      requires: {
        connections: this.deriveConnections(automations, request.connections),
        ai: this.deriveAiNeed(agents, request.ai),
      },
      databases,
      relations,
      states,
      agents,
      triggers,
      derived_fields: derivedFields,
      views,
      automations,
      sample_records: sampleRecords,
      skills,
    });

    const leaked = findRawUuids(manifest);
    if (leaked.length > 0) {
      // Not an assertion for the test's benefit: reaching here means some path
      // produced a manifest that would install pointing at this workspace's
      // fields. Better to fail the export than to ship that.
      throw new UnprocessableEntityException(
        `Export produced a manifest containing raw ids (${leaked.slice(0, 3).join(', ')}). ` +
          `This is a bug in the exporter — a pack must contain only symbolic refs.`,
      );
    }
    return manifest;
  }

  /**
   * Skills (#40) explicitly requested for this pack, by id.
   *
   * Not derived from the slice — a skill is workspace-wide, not attached to a
   * space or a list of database ids (see `packExportRequestSchema.skill_ids`'s
   * doc) — so this is a straight lookup-and-translate: `SkillsService`'s
   * visible-to-caller rules decide what a caller may even name here (a
   * personal skill of someone else's is a 404, same as everywhere else that
   * service is used), and the result is #40's own portable shape, unchanged —
   * a skill carries no ids to rewrite.
   */
  private async exportSkills(membership: Membership, ids: string[]): Promise<PackSkill[]> {
    const out: PackSkill[] = [];
    const seenNames = new Set<string>();
    for (const id of ids) {
      const skill = await this.skills.get(membership, membership.userId, id);
      const key = norm(skill.name);
      if (seenNames.has(key)) {
        throw new UnprocessableEntityException(
          `Two requested skills both named "${skill.name}" (case/whitespace-insensitively) — ` +
            `rename one. A pack cannot contain two skills a re-install could not tell apart.`,
        );
      }
      seenNames.add(key);
      out.push({
        name: skill.name,
        description: skill.description,
        when_to_use: skill.when_to_use,
        instructions: skill.instructions,
        examples: skill.examples,
        allowed_tools: skill.allowed_tools,
      });
    }
    return out;
  }

  /** The plain (ref-free) part of a field's config, or undefined if empty. */
  private plainConfig(field: LiveField): Record<string, unknown> | undefined {
    // Redacted for the same reason as the derived-field configs above: a pack
    // leaves the workspace.
    const config = redactSecrets(field.config ?? {});
    const entries = Object.entries(config).filter(([, v]) => v !== null && v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /** The databases the request names, minus the system pack. */
  private async readSlice(membership: Membership, request: PackExportRequest): Promise<SliceDb[]> {
    const all = await this.databases.list(membership);
    // A plan places databases in a space *by name* — that is what
    // `ArchitectService.ensureSpace` matches on — but `databases.list` carries
    // only the space id, so the names are resolved here once.
    const spaceNames = new Map(
      (await this.spaces.list(membership)).map((s) => [s.id, s.name] as const),
    );

    const wanted = request.space
      ? all.filter((d) => norm(spaceNames.get(d.spaceId) ?? '') === norm(request.space!))
      : all.filter((d) => request.database_ids!.includes(d.id));

    if (wanted.length === 0) {
      throw new UnprocessableEntityException(
        request.space
          ? `No databases found in a space named "${request.space}".`
          : `None of those database ids are in this workspace.`,
      );
    }

    const slice: SliceDb[] = [];
    for (const db of wanted) {
      // The Agents/Runs/Agent Triggers databases are provisioned by
      // `ensurePack`, not by manifests. Exporting them as ordinary databases
      // would make install try to create a second "Agents" — and the agent
      // records inside them are exported properly, as `agents`.
      if (SYSTEM_DBS.has(norm(db.name))) continue;
      const detail = await this.databases.get(membership, db.id);
      slice.push({
        id: db.id,
        name: db.name,
        space: spaceNames.get(db.spaceId) ?? 'General',
        fields: detail.fields as unknown as LiveField[],
        views: (detail as unknown as { views: LiveView[] }).views ?? [],
      });
    }
    if (slice.length === 0) {
      throw new UnprocessableEntityException(
        `That slice contains only Agentic OS system databases, which every workspace ` +
          `provisions for itself. There is nothing to export.`,
      );
    }
    return slice;
  }

  /**
   * The export ref table: every id in the slice → its symbolic ref.
   *
   * Collisions are fatal. `packSlug` is lossy ("Due date" and "Due-Date" both
   * slug to `due-date`), and a manifest where two fields share a ref is one
   * where install silently wires half of them to the wrong field. Refusing here
   * costs a rename; not refusing costs a debugging session in someone else's
   * workspace.
   */
  private buildExportRefs(slice: SliceDb[]): Map<string, string> {
    const idToRef = new Map<string, string>();
    const seen = new Map<string, string>();

    const claim = (ref: string, id: string, what: string) => {
      const already = seen.get(ref);
      if (already && already !== what) {
        throw new UnprocessableEntityException(
          `"${what}" and "${already}" both reduce to the pack ref "${ref}". Rename one — a ` +
            `pack cannot contain two things with the same ref.`,
        );
      }
      seen.set(ref, what);
      idToRef.set(id, ref);
    };

    for (const db of slice) {
      claim(dbRef(db.name), db.id, db.name);
      for (const field of db.fields) {
        claim(fieldRef(db.name, field.displayName), field.id, `${db.name}.${field.displayName}`);
        for (const option of field.options ?? []) {
          claim(
            optionRef(db.name, field.displayName, option.label),
            option.id,
            `${db.name}.${field.displayName}.${option.label}`,
          );
        }
      }
    }
    return idToRef;
  }

  /**
   * Relations, once each, from the "a" side.
   *
   * `RelationsService.create` writes the `from` database as side "a" and the
   * `to` as side "b" (relations.service.ts), and `ArchitectService.buildRelations`
   * reads a plan's `from`/`to` back into exactly that — so exporting from side
   * "a" is what closes the loop rather than mirroring the relation on install.
   */
  private async exportRelations(slice: SliceDb[]): Promise<PlanRelation[]> {
    const byId = new Map(slice.map((d) => [d.id, d]));
    const out: PlanRelation[] = [];
    const seen = new Set<string>();

    for (const db of slice) {
      for (const relation of await this.relations.forDatabase(db.id)) {
        if (seen.has(relation.id)) continue;
        const from = byId.get(relation.databaseAId);
        const to = byId.get(relation.databaseBId);
        // A relation with one leg outside the slice cannot come along: the
        // database it points at will not exist in the target workspace. Skipped
        // rather than fatal — a slice is allowed to have edges, and the fields
        // on the exported side simply do not appear.
        if (!from || !to) continue;
        seen.add(relation.id);

        const fieldA = from.fields.find((f) => f.id === relation.fieldAId);
        const fieldB = to.fields.find((f) => f.id === relation.fieldBId);
        if (!fieldA || !fieldB) continue;

        out.push({
          from: from.name,
          to: to.name,
          cardinality: relation.cardinality,
          from_field: fieldA.displayName,
          to_field: fieldB.displayName,
        });
      }
    }
    return out;
  }

  /**
   * Agent definitions and their state bindings, from the system databases.
   *
   * Only agents whose bindings target the slice come along — an agent that
   * watches a database the pack does not contain is not part of this pack.
   */
  private async exportAgents(
    membership: Membership,
    slice: SliceDb[],
    agentsDbId: string,
    bindings: Array<{ id: string; values: Record<string, unknown> }>,
  ): Promise<{ agents: PackAgent[]; triggers: PlanTrigger[] }> {
    const byId = new Map(slice.map((d) => [d.id, d]));
    const agentRows = await this.records.list(agentsDbId, { limit: MAX_SCAN });
    const agentById = new Map(agentRows.data.map((r) => [r.id, r]));
    const agentFields = (await this.databases.get(membership, agentsDbId))
      .fields as unknown as LiveField[];

    /** Option ids on the Agents database → their labels (scopes, approval_policy). */
    const labelOf = (apiName: string, optionId: unknown): string | null => {
      if (typeof optionId !== 'string') return null;
      const field = agentFields.find((f) => f.apiName === apiName);
      return field?.options?.find((o) => o.id === optionId)?.label ?? null;
    };

    const triggers: PlanTrigger[] = [];
    const wantedAgentIds = new Set<string>();

    for (const binding of bindings) {
      const db = byId.get(binding.values['database'] as string);
      if (!db) continue;
      const agentId = ((binding.values['agent'] as Array<{ id: string }> | undefined) ?? [])[0]?.id;
      const agent = agentId ? agentById.get(agentId) : undefined;
      if (!agent) continue;

      const field = db.fields.find((f) => f.id === binding.values['state_field']);
      const option = field?.options?.find((o) => o.id === binding.values['state_option']);
      if (!field || !option) continue;

      wantedAgentIds.add(agent.id);
      triggers.push({
        agent: agent.title,
        database: db.name,
        state_field: field.displayName,
        state_option: option.label,
        human_gate: binding.values['human_gate'] === true,
      });
    }

    const agents: PackAgent[] = [];
    for (const id of wantedAgentIds) {
      const row = agentById.get(id)!;
      const targets = String(row.values['target_databases'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .map((dbId) => byId.get(dbId)?.name)
        .filter((name): name is string => Boolean(name));

      agents.push({
        name: row.title,
        goal: this.plainText(row.values['goal']) || row.title,
        instructions: this.plainText(row.values['instructions']) || undefined,
        scopes: ((row.values['scopes'] as unknown[]) ?? [])
          .map((o) => labelOf('scopes', o))
          .filter((l): l is PlanAgent['scopes'][number] =>
            ['read', 'write', 'admin'].includes(l ?? ''),
          ),
        approval_policy: ((row.values['approval_policy'] as unknown[]) ?? [])
          .map((o) => labelOf('approval_policy', o))
          .filter((l): l is PlanAgent['approval_policy'][number] =>
            ['delete', 'webhook', 'email', 'run_button', 'outward'].includes(l ?? ''),
          ),
        target_databases: targets,
        // No live agent↔skill relation exists yet (see packAgentSchema's
        // doc) — an Agent record has nowhere to have recorded this, so it is
        // always empty coming out of export. Hand-editing the manifest to
        // add names here (matched against `skills[].name`) is what the field
        // is for; install validates them either way.
        skills: [],
      });
    }
    return { agents, triggers };
  }

  /** Flatten a BlockNote document to text — `goal`/`instructions` are rich_text. */
  private plainText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; text?: string; content?: unknown[]; children?: unknown[] };
      if (typeof n.text === 'string') parts.push(n.text);
      (n.content ?? []).forEach(walk);
      (n.children ?? []).forEach(walk);
    };
    value.forEach(walk);
    return parts.join('').trim();
  }

  private exportViews(slice: SliceDb[], idToRef: Map<string, string>) {
    return slice.flatMap((db) =>
      db.views.map((view) => ({
        database: db.name,
        name: view.name,
        type: view.type as 'table',
        config: refify(
          view.config ?? {},
          idToRef,
          `The view "${db.name}.${view.name}"`,
        ) as Record<string, unknown>,
      })),
    );
  }

  private async exportAutomations(slice: SliceDb[], idToRef: Map<string, string>) {
    const out = [];
    for (const db of slice) {
      const { data } = await this.automations.list(db.id);
      for (const rule of data) {
        const where = `The automation "${db.name}.${rule.name}"`;
        out.push({
          database: db.name,
          name: rule.name,
          trigger: refify(rule.trigger ?? {}, idToRef, where) as Record<string, unknown>,
          condition: rule.condition ? refify(rule.condition, idToRef, where) : undefined,
          // Same as the button configs: a `send_webhook` action's headers/URL are
          // credentials, and a pack is published.
          actions: ((rule.actions as unknown[]) ?? []).map(
            (a) => refify(redactSecrets(a), idToRef, where) as Record<string, unknown>,
          ),
          enabled: rule.enabled,
        });
      }
    }
    return out;
  }

  private async exportSampleRecords(
    slice: SliceDb[],
    idToRef: Map<string, string>,
    limit: number,
  ) {
    const out = [];
    for (const db of slice) {
      const portable = new Set(
        db.fields.filter((f) => PORTABLE_VALUE_TYPES.has(f.type)).map((f) => f.apiName),
      );
      const { data } = await this.records.list(db.id, { limit });
      for (const record of data) {
        const values: Record<string, unknown> = { name: record.title };
        for (const [key, value] of Object.entries(record.values)) {
          if (!portable.has(key)) continue;
          const rewritten = refify(value, idToRef, `A sample record of "${db.name}"`, 'drop');
          if (rewritten !== undefined) values[key] = rewritten;
        }
        out.push({ database: db.name, values });
      }
    }
    return out;
  }

  /**
   * Required connections, derived from what the pack actually contains.
   *
   * Derivation beats declaration for anything provable: an author who forgets to
   * declare Slack still ships a pack that posts to Slack, and the operator finds
   * out when it silently does not. `declared` is merged on top for the intent
   * the content cannot express (an agent meant to file GitHub issues).
   */
  private deriveConnections(
    automations: Array<{ actions: Array<Record<string, unknown>> }>,
    declared: PackConnection[],
  ): PackConnection[] {
    const needed = new Set<PackConnection>(declared);
    for (const rule of automations) {
      for (const action of rule.actions) {
        if (action.type === 'send_slack_message') needed.add('slack');
        if (action.type === 'notify_user') needed.add('email');
      }
    }
    return [...needed].sort();
  }

  /**
   * The AI need. An agent-bearing pack defaults to `byo` — your own model over
   * MCP, which is never metered (ADR-0010) — because that is the path that works
   * today: `ManagedAiRuntime` throws. Defaulting to `storyos` would declare a
   * dependency on something no workspace can satisfy.
   */
  private deriveAiNeed(agents: PlanAgent[], override?: PackAiNeed): PackAiNeed {
    if (override) return override;
    return agents.length > 0 ? 'byo' : 'none';
  }

  // ── preview ────────────────────────────────────────────────────────────────

  /**
   * What `install` would do, without doing it (MN-219 / #161).
   *
   * The same split `ArchitectService` already draws between `propose` (reads,
   * writes nothing) and `build` (executes) — here between `preview` and
   * `install`. Deliberately does NOT call `agents.ensurePack()`: that
   * provisions the Agents/Runs/Agent Triggers databases, and calling it from a
   * preview would make "preview creates nothing" false the first time anyone
   * previewed a pack with agents in it. If the Agents database has never been
   * provisioned, every agent in the manifest previews as `create` — which is
   * correct, since that is exactly what installing it would do.
   */
  async preview(membership: Membership, rawManifest: unknown): Promise<PackPreviewResult> {
    const manifest = this.parseManifest(rawManifest);
    const unmet = await this.checkRequirements(membership, manifest);
    const collisions = await this.computeCollisions(membership, manifest);
    return { slug: manifest.slug, name: manifest.name, version: manifest.version, unmet, ...collisions };
  }

  /**
   * Classify every database/view/automation/agent the manifest plans against
   * live state — `create` | `reuse` | `collision` — the one piece of logic
   * `preview` and `install` share (MN-219 / #161). `reuse` and `collision`
   * both mean "a live object already has this name"; the tracked-provenance
   * lookup (`pack_installs`/`pack_install_items`) is what tells them apart —
   * see `packPreviewItemSchema`'s doc.
   */
  private async computeCollisions(
    membership: Membership,
    manifest: PackManifest,
  ): Promise<{
    databases: PackPreviewItem[];
    views: PackPreviewItem[];
    automations: PackPreviewItem[];
    agents: PackPreviewItem[];
  }> {
    const existingInstall = await this.findExistingInstall(membership.workspaceId, manifest.slug);
    const tracked = existingInstall
      ? {
          database: await this.trackedNames(existingInstall.id, 'database'),
          view: await this.trackedNames(existingInstall.id, 'view'),
          automation: await this.trackedNames(existingInstall.id, 'automation'),
          agent: await this.trackedNames(existingInstall.id, 'agent'),
        }
      : undefined;
    const classify = (kind: 'database' | 'view' | 'automation' | 'agent', label: string, exists: boolean): PackPreviewItem['action'] => {
      if (!exists) return 'create';
      return tracked?.[kind].has(norm(label)) ? 'reuse' : 'collision';
    };

    const liveDbs = await this.databases.list(membership);
    const liveByName = new Map(liveDbs.map((d) => [norm(d.name), d]));

    const databases: PackPreviewItem[] = manifest.databases.map((d) => ({
      name: d.name,
      action: classify('database', d.name, liveByName.has(norm(d.name))),
    }));

    // Views/automations only exist once their database does — a planned
    // database that isn't live yet previews all of its views and automations
    // as `create` without ever asking a database id that doesn't exist for
    // its children.
    // Value: normalized view name → is it the database's default ("All
    // records")? Every database is provisioned with exactly one (see
    // `LiveView.isDefault`'s doc) — it is scaffolding, not pack content, so a
    // planned view that matches it is never a `collision` needing a person's
    // decision, whatever the tracked-provenance lookup would otherwise say.
    const viewNamesByDb = new Map<string, Map<string, boolean>>();
    const automationNamesByDb = new Map<string, Set<string>>();

    const views: PackPreviewItem[] = [];
    for (const planned of manifest.views) {
      const label = `${planned.database}.${planned.name}`;
      const live = liveByName.get(norm(planned.database));
      if (!live) {
        views.push({ name: label, action: 'create' });
        continue;
      }
      let names = viewNamesByDb.get(live.id);
      if (!names) {
        const detail = await this.databases.get(membership, live.id);
        names = new Map(
          ((detail as unknown as { views: LiveView[] }).views ?? []).map(
            (v) => [norm(v.name), Boolean(v.isDefault)] as const,
          ),
        );
        viewNamesByDb.set(live.id, names);
      }
      const match = names.get(norm(planned.name));
      const action = match === undefined ? 'create' : match ? 'reuse' : classify('view', label, true);
      views.push({ name: label, action });
    }

    const automations: PackPreviewItem[] = [];
    for (const planned of manifest.automations) {
      const label = `${planned.database}.${planned.name}`;
      const live = liveByName.get(norm(planned.database));
      if (!live) {
        automations.push({ name: label, action: 'create' });
        continue;
      }
      let names = automationNamesByDb.get(live.id);
      if (!names) {
        const { data } = await this.automations.list(live.id);
        names = new Set(data.map((r) => norm(r.name)));
        automationNamesByDb.set(live.id, names);
      }
      automations.push({
        name: label,
        action: classify('automation', label, names.has(norm(planned.name))),
      });
    }

    const { agentsDb } = await this.agents.findPackDbs(membership.workspaceId);
    let agentTitles: Set<string> | undefined;
    if (agentsDb) {
      const { data } = await this.records.list(agentsDb.id, { limit: MAX_SCAN });
      agentTitles = new Set(data.map((r) => norm(r.title)));
    }
    const agents: PackPreviewItem[] = manifest.agents.map((a) => ({
      name: a.name,
      action: classify('agent', a.name, agentTitles?.has(norm(a.name)) ?? false),
    }));

    return { databases, views, automations, agents };
  }

  private parseManifest(rawManifest: unknown): PackManifest {
    const parsed = packManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `This is not a valid pack manifest: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private async findExistingInstall(workspaceId: string, slug: string) {
    return this.db.query.packInstalls.findFirst({
      where: and(
        eq(packInstalls.workspaceId, workspaceId),
        eq(packInstalls.slug, slug),
        isNull(packInstalls.uninstalledAt),
      ),
    });
  }

  private async trackedNames(
    packInstallId: string,
    kind: 'database' | 'view' | 'automation' | 'agent' | 'skill',
  ): Promise<Set<string>> {
    const rows = await this.db.query.packInstallItems.findMany({
      where: and(eq(packInstallItems.packInstallId, packInstallId), eq(packInstallItems.kind, kind)),
    });
    return new Set(rows.map((r) => norm(r.name)));
  }

  // ── install ────────────────────────────────────────────────────────────────

  /**
   * Install a manifest into this workspace.
   *
   * Deterministic and idempotent because it does almost nothing itself: the
   * schema half is `ArchitectService.build`, whose every step is find-by-name
   * first. The parts added here follow the same rule — a view, automation or
   * sample record is matched by name on its database before it is created — so a
   * second install of the same manifest creates nothing.
   *
   * `resolutions` (MN-219 / #161) answers every `collision` `preview` would
   * report (see `computeCollisions`) — keyed by the same label `preview`
   * showed. Anything still unresolved is a 409, not a guess: installing on a
   * genuine name collision without an explicit decision is exactly the
   * silent-adoption bug `preview` exists to let a person catch first.
   */
  async install(
    membership: Membership,
    rawManifest: unknown,
    resolutions: PackInstallResolutions = {},
  ): Promise<PackInstallResult> {
    const manifest = this.parseManifest(rawManifest);
    // Fail fast, before anything is built: a manifest whose agent declares a
    // skill it does not bundle is malformed the same way a dangling `$ref`
    // is, and the same rule applies — a broken promise about the manifest's
    // own contents is a 422, not a partial install.
    this.validateAgentSkillNames(manifest);
    const unmet = await this.checkRequirements(membership, manifest);

    const existingInstall = await this.findExistingInstall(membership.workspaceId, manifest.slug);
    const collisions = await this.computeCollisions(membership, manifest);
    const { manifest: working, skippedAgents, viewResolutions, automationResolutions } =
      this.applyResolutions(manifest, collisions, resolutions);

    // ── The reuse: a PackManifest IS an ArchitectPlan ────────────────────────
    // Databases, fields, relations, states, agents and bindings — all of it,
    // through the walk #214 already ships. Nothing about that walk is
    // reimplemented, adapted or wrapped here.
    const built = await this.architect.build(membership, working);

    const result: PackInstallResult = {
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      unmet,
      spaces: built.spaces,
      databases: built.databases,
      fields: built.fields,
      relations: built.relations,
      states: built.states,
      agents: [...built.agents, ...skippedAgents.map((name) => ({ name, action: 'skipped' as const, id: '' }))],
      triggers: built.triggers,
      derived_fields: [],
      views: [],
      automations: [],
      sample_records: [],
      skills: [],
    };

    const dbIds = new Map(built.databases.map((d) => [norm(d.name), d.id]));

    // Derived fields go in before the ref table the views use is built: a view
    // may size or show a rollup column, so the rollup has to exist first.
    await this.installDerivedFields(membership, working, dbIds, result);

    const refToId = await this.readInstallRefs(membership, working, dbIds);
    const hashes = new Map<string, string>();
    // Entity ids never worth a `pack_install_items` row — currently just a
    // database's default view (see `installViews`'s doc). `recordInstall`
    // filters these out so `uninstall` never learns about them at all.
    const untracked = new Set<string>();
    await this.installViews(membership, working, dbIds, refToId, result, viewResolutions, hashes, untracked);
    await this.installAutomations(
      membership,
      working,
      dbIds,
      refToId,
      result,
      automationResolutions,
      hashes,
    );
    await this.installSampleRecords(membership, working, dbIds, refToId, result);
    await this.installSkills(membership, working, result, hashes);
    await this.hashInstalledAgents(membership, result, hashes);

    await this.recordInstall(membership, manifest, result, existingInstall, hashes, untracked);

    return result;
  }

  /**
   * Resolve every collision `computeCollisions` reported, per `resolutions`.
   *
   * Databases only accept `reuse` — see `packInstallResolutionSchema`'s doc on
   * why `rename` isn't offered there (the symbolic `$db`/`$field`/`$option` ref
   * table is derived from a database's *name*, so renaming it mid-manifest
   * would desynchronize every ref embedded in view/automation configs
   * elsewhere — a correctness risk, not a UI gap). Agents, views and
   * automations carry no such ref and accept the full `reuse`/`rename`/`skip`
   * set.
   */
  private applyResolutions(
    manifest: PackManifest,
    collisions: {
      databases: PackPreviewItem[];
      views: PackPreviewItem[];
      automations: PackPreviewItem[];
      agents: PackPreviewItem[];
    },
    resolutions: PackInstallResolutions,
  ): {
    manifest: PackManifest;
    skippedAgents: string[];
    viewResolutions: Map<string, PackInstallResolutions[string]>;
    automationResolutions: Map<string, PackInstallResolutions[string]>;
  } {
    const unresolved: string[] = [];

    for (const item of collisions.databases) {
      if (item.action !== 'collision') continue;
      const resolution = resolutions[item.name];
      if (!resolution) {
        unresolved.push(`Database "${item.name}"`);
        continue;
      }
      if (resolution.action !== 'reuse') {
        throw new UnprocessableEntityException(
          `Database "${item.name}" already exists and is not from a previous install of this ` +
            `pack. Only "reuse" is supported for a database name collision in this release — ` +
            `rename your existing database first, or resolve it as "reuse" to adopt it as this ` +
            `pack's.`,
        );
      }
      // No manifest change: `reuse` is exactly what `ArchitectService.build`'s
      // own find-by-name already does.
    }

    let working = manifest;
    const skippedAgents: string[] = [];
    for (const item of collisions.agents) {
      if (item.action !== 'collision') continue;
      const resolution = resolutions[item.name];
      if (!resolution) {
        unresolved.push(`Agent "${item.name}"`);
        continue;
      }
      if (resolution.action === 'skip') {
        working = this.removeAgent(working, item.name);
        skippedAgents.push(item.name);
      } else if (resolution.action === 'rename') {
        working = this.renameAgent(working, item.name, resolution.rename_to!);
      }
    }

    const viewResolutions = new Map<string, PackInstallResolutions[string]>();
    for (const item of collisions.views) {
      if (item.action !== 'collision') continue;
      const resolution = resolutions[item.name];
      if (!resolution) {
        unresolved.push(`View "${item.name}"`);
        continue;
      }
      viewResolutions.set(item.name, resolution);
    }

    const automationResolutions = new Map<string, PackInstallResolutions[string]>();
    for (const item of collisions.automations) {
      if (item.action !== 'collision') continue;
      const resolution = resolutions[item.name];
      if (!resolution) {
        unresolved.push(`Automation "${item.name}"`);
        continue;
      }
      automationResolutions.set(item.name, resolution);
    }

    if (unresolved.length > 0) {
      throw new ConflictException(
        `This pack collides with existing objects that need a decision: ${unresolved.join(', ')}. ` +
          `Call preview to see every collision, then install again with a \`resolutions\` entry ` +
          `(reuse/rename/skip) for each.`,
      );
    }

    return { manifest: working, skippedAgents, viewResolutions, automationResolutions };
  }

  private removeAgent(manifest: PackManifest, name: string): PackManifest {
    return {
      ...manifest,
      agents: manifest.agents.filter((a) => norm(a.name) !== norm(name)),
      triggers: manifest.triggers.filter((t) => norm(t.agent) !== norm(name)),
    };
  }

  private renameAgent(manifest: PackManifest, oldName: string, newName: string): PackManifest {
    return {
      ...manifest,
      agents: manifest.agents.map((a) => (norm(a.name) === norm(oldName) ? { ...a, name: newName } : a)),
      triggers: manifest.triggers.map((t) =>
        norm(t.agent) === norm(oldName) ? { ...t, agent: newName } : t,
      ),
    };
  }

  /** Stable JSON — object keys sorted recursively, so two equal values hash equal regardless of insertion order. */
  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.canonicalize(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = this.canonicalize((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }

  private hashOf(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(this.canonicalize(value))).digest('hex');
  }

  /**
   * Live agent records' content, hashed for uninstall's modified-since-install
   * check — computed after `architect.build` rather than inside
   * `installViews`-style loops, because agents are created by `build`, not by
   * this service (see `install`'s header on "a PackManifest IS an
   * ArchitectPlan").
   */
  private async hashInstalledAgents(
    membership: Membership,
    result: PackInstallResult,
    hashes: Map<string, string>,
  ): Promise<void> {
    const real = result.agents.filter((a) => a.action !== 'skipped' && a.id);
    if (real.length === 0) return;
    const { agentsDb } = await this.agents.findPackDbs(membership.workspaceId);
    if (!agentsDb) return;
    for (const agent of real) {
      const record = await this.records.get(agentsDb.id, agent.id);
      hashes.set(`agent:${agent.id}`, this.hashOf(record.values));
    }
  }

  /**
   * Persist what this install touched (MN-219 / #161) — the provenance
   * `computeCollisions` (next install/preview) and `uninstall` both read.
   *
   * A re-install of the same slug updates the existing `pack_installs` row in
   * place and replaces its items wholesale rather than diffing them: the
   * fresh set from this run *is* the current truth, and nothing here is
   * matched against the old rows for anything other than "is this the same
   * pack" (already settled by `existingInstall`).
   */
  private async recordInstall(
    membership: Membership,
    manifest: PackManifest,
    result: PackInstallResult,
    existingInstall: { id: string } | undefined,
    hashes: Map<string, string>,
    untracked: Set<string> = new Set(),
  ): Promise<void> {
    let installId: string;
    if (existingInstall) {
      installId = existingInstall.id;
    } else {
      const [inserted] = await this.db
        .insert(packInstalls)
        .values({
          workspaceId: membership.workspaceId,
          slug: manifest.slug,
          name: manifest.name,
          version: manifest.version,
          installedBy: membership.userId,
        })
        .returning({ id: packInstalls.id });
      installId = inserted!.id;
    }

    if (existingInstall) {
      await this.db
        .update(packInstalls)
        .set({ name: manifest.name, version: manifest.version, installedBy: membership.userId })
        .where(eq(packInstalls.id, installId));
      await this.db.delete(packInstallItems).where(eq(packInstallItems.packInstallId, installId));
    }

    type Kind =
      | 'database' | 'field' | 'relation' | 'state' | 'agent' | 'trigger'
      | 'derived_field' | 'view' | 'automation' | 'sample_record' | 'skill';
    const rows: Array<{
      packInstallId: string;
      kind: Kind;
      name: string;
      entityId: string;
      action: 'created' | 'reused';
      contentHash: string | null;
    }> = [];
    const add = (kind: Kind, entries: Array<{ name: string; action: string; id: string }>) => {
      for (const entry of entries) {
        if (entry.action === 'skipped' || !entry.id || untracked.has(entry.id)) continue;
        rows.push({
          packInstallId: installId,
          kind,
          name: entry.name,
          entityId: entry.id,
          action: entry.action as 'created' | 'reused',
          contentHash: hashes.get(`${kind}:${entry.id}`) ?? null,
        });
      }
    };
    add('database', result.databases);
    add('field', result.fields);
    add('relation', result.relations);
    add('state', result.states);
    add('agent', result.agents);
    add('trigger', result.triggers);
    add('derived_field', result.derived_fields);
    add('view', result.views);
    add('automation', result.automations);
    add('sample_record', result.sample_records);
    add('skill', result.skills);

    if (rows.length > 0) await this.db.insert(packInstallItems).values(rows);
  }

  /**
   * Every tracked install in this workspace, newest first (MN-219 / #161),
   * each carrying whether a newer version exists (MN-220).
   *
   * `latest_version` is looked up live via `MarketplaceService.latestVersionOf`
   * rather than read off anything cached on the install row — see that
   * method's own doc for why that's the one that stays honest when a pack is
   * updated, or unpublished, out from under an existing install.
   */
  async listInstalls(membership: Membership): Promise<PackInstallSummary[]> {
    const rows = await this.db.query.packInstalls.findMany({
      where: and(eq(packInstalls.workspaceId, membership.workspaceId), isNull(packInstalls.uninstalledAt)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return Promise.all(
      rows.map(async (r) => {
        const latest = await this.marketplace.latestVersionOf(r.slug);
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          version: r.version,
          installed_at: r.createdAt.toISOString(),
          installed_by: r.installedBy,
          latest_version: latest,
          update_available: latest !== null && compareSemver(latest, r.version) > 0,
        };
      }),
    );
  }

  /**
   * Uninstall (MN-219 / #161) — removes what this install made, keeps what a
   * person has since changed.
   *
   * Scoped to views, automations, agents and skills. Schema (databases,
   * fields, relations, states) and sample records are never touched here —
   * see `packUninstallResultSchema`'s doc: deleting a database cascades to
   * everything hanging off it, including anything the user built on top since
   * install, and there is no per-field/per-record modified-since-install
   * signal to gate that safely. An agent's trigger bindings are removed
   * alongside it unconditionally (a binding is part of the agent's own
   * definition, not separately editable content), regardless of the agent
   * record's own modified state.
   */
  async uninstall(membership: Membership, packInstallId: string): Promise<PackUninstallResult> {
    const install = await this.db.query.packInstalls.findFirst({
      where: and(eq(packInstalls.id, packInstallId), eq(packInstalls.workspaceId, membership.workspaceId)),
    });
    if (!install || install.uninstalledAt) {
      throw new UnprocessableEntityException('No installed pack matches that id in this workspace.');
    }
    const items = await this.db.query.packInstallItems.findMany({
      where: eq(packInstallItems.packInstallId, packInstallId),
    });

    const removed: PackUninstallResult['removed'] = [];
    const kept: PackUninstallResult['kept'] = [];
    const { agentsDb, triggersDb } = await this.agents.findPackDbs(membership.workspaceId);

    for (const item of items) {
      if (item.kind === 'view') {
        const database = item.name.split('.')[0] ?? item.name;
        const dbId = await this.findDbIdByName(membership, database);
        const live = dbId ? await this.findLiveView(membership, dbId, item.entityId) : undefined;
        if (!live) continue; // already gone — nothing to remove or keep
        // Belt-and-braces: `installViews` no longer tracks a database's
        // default view at all (see its doc), so this should be unreachable —
        // but a database's default view must never be deleted regardless of
        // how a row for it ended up here (`ViewsService.remove` refuses to
        // drop a database's last view; better to say why than to 409 mid-uninstall).
        if (live.isDefault) {
          kept.push({
            kind: 'view',
            name: item.name,
            id: item.entityId,
            reason: "A database's default view is never removed.",
          });
          continue;
        }
        if (this.hashOf({ name: live.name, type: live.type, config: live.config }) !== item.contentHash) {
          kept.push({ kind: 'view', name: item.name, id: item.entityId, reason: 'Changed since install.' });
          continue;
        }
        await this.views.remove(dbId!, item.entityId);
        removed.push({ kind: 'view', name: item.name, id: item.entityId });
      } else if (item.kind === 'automation') {
        const database = item.name.split('.')[0] ?? item.name;
        const dbId = await this.findDbIdByName(membership, database);
        const live = dbId ? await this.findLiveAutomation(dbId, item.entityId) : undefined;
        if (!live) continue;
        const projection = {
          name: live.name,
          trigger: live.trigger,
          condition: live.condition,
          actions: live.actions,
          enabled: live.enabled,
        };
        if (this.hashOf(projection) !== item.contentHash) {
          kept.push({
            kind: 'automation',
            name: item.name,
            id: item.entityId,
            reason: 'Changed since install.',
          });
          continue;
        }
        await this.automations.remove(dbId!, item.entityId);
        removed.push({ kind: 'automation', name: item.name, id: item.entityId });
      } else if (item.kind === 'agent') {
        if (!agentsDb) continue;
        let record;
        try {
          record = await this.records.get(agentsDb.id, item.entityId);
        } catch {
          continue; // already gone
        }
        if (this.hashOf(record.values) !== item.contentHash) {
          kept.push({ kind: 'agent', name: item.name, id: item.entityId, reason: 'Changed since install.' });
          continue;
        }
        if (triggersDb) {
          const { data: bindings } = await this.records.list(triggersDb.id, { limit: MAX_SCAN });
          for (const binding of bindings) {
            const boundAgentId = ((binding.values['agent'] as Array<{ id: string }> | undefined) ?? [])[0]?.id;
            if (boundAgentId === item.entityId) {
              await this.records.softDelete(membership.workspaceId, triggersDb.id, binding.id, membership.userId);
            }
          }
        }
        await this.records.softDelete(membership.workspaceId, agentsDb.id, item.entityId, membership.userId);
        removed.push({ kind: 'agent', name: item.name, id: item.entityId });
      } else if (item.kind === 'skill') {
        let skill;
        try {
          skill = await this.skills.get(membership, membership.userId, item.entityId);
        } catch {
          continue;
        }
        const projection = {
          name: skill.name,
          description: skill.description,
          when_to_use: skill.when_to_use,
          instructions: skill.instructions,
          examples: skill.examples,
          allowed_tools: skill.allowed_tools,
        };
        if (this.hashOf(projection) !== item.contentHash) {
          kept.push({ kind: 'skill', name: item.name, id: item.entityId, reason: 'Changed since install.' });
          continue;
        }
        await this.skills.remove(membership, membership.userId, item.entityId);
        removed.push({ kind: 'skill', name: item.name, id: item.entityId });
      }
    }

    await this.db.update(packInstalls).set({ uninstalledAt: new Date() }).where(eq(packInstalls.id, packInstallId));
    return { removed, kept };
  }

  private async findDbIdByName(membership: Membership, name: string): Promise<string | undefined> {
    const live = await this.databases.list(membership);
    return live.find((d) => norm(d.name) === norm(name))?.id;
  }

  private async findLiveView(
    membership: Membership,
    dbId: string,
    viewId: string,
  ): Promise<LiveView | undefined> {
    const detail = await this.databases.get(membership, dbId);
    return ((detail as unknown as { views: LiveView[] }).views ?? []).find((v) => v.id === viewId);
  }

  private async findLiveAutomation(
    dbId: string,
    ruleId: string,
  ): Promise<
    { name: string; trigger: unknown; condition?: unknown; actions: unknown; enabled: boolean } | undefined
  > {
    const { data } = await this.automations.list(dbId);
    return data.find((r) => r.id === ruleId);
  }

  /**
   * Unmet requirements — reported, never fatal.
   *
   * A pack whose Slack connection is missing still installs: the schema, views,
   * states and agents are all useful, and refusing would leave the operator with
   * nothing to connect Slack *to*. What would be unacceptable is installing
   * quietly, so the gap comes back in the result.
   */
  private async checkRequirements(
    membership: Membership,
    manifest: PackManifest,
  ): Promise<PackUnmetRequirement[]> {
    const unmet: PackUnmetRequirement[] = [];
    const ws = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, membership.workspaceId),
    });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;

    const connected = (name: PackConnection): boolean => {
      if (name === 'slack') {
        const slack = (settings.slack ?? {}) as { bot_token?: string; webhook_url?: string };
        return Boolean(slack.bot_token || slack.webhook_url);
      }
      if (name === 'github') return Boolean((settings.github as { token?: string })?.token);
      if (name === 'linear') return Boolean((settings.linear as { api_key?: string })?.api_key);
      // The built-in mailer is configured per deployment rather than per
      // workspace, so from here it is always available. Listed as a requirement
      // anyway because a pack that emails people depends on it.
      return true;
    };

    for (const name of manifest.requires.connections) {
      if (connected(name)) continue;
      unmet.push({
        kind: 'connection',
        name,
        detail:
          `This pack sends to ${name}, which is not connected in this workspace. Everything ` +
          `else installed; connect ${name} in workspace settings to switch it on.`,
      });
    }

    if (manifest.requires.ai === 'storyos') {
      // ADR-0010 §3: the managed runtime is a seam that throws. Saying so is
      // better than installing a pack whose agents cannot run and letting the
      // operator discover it at the first transition.
      unmet.push({
        kind: 'ai',
        name: 'storyos',
        detail:
          `This pack asks for StoryOS's managed AI, which is not available yet. Its agents ` +
          `install but will not run until you point them at your own model over MCP.`,
      });
    }
    return unmet;
  }

  /**
   * The install ref table: `ref → id`, read back from live schema.
   *
   * Built from the *same names by the same rules* as `buildExportRefs`, rather
   * than from `build`'s result — which is what makes export and install provably
   * symmetric, and which also picks up option ids (the build result carries a
   * state's field id but not its options').
   */
  private async readInstallRefs(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
  ): Promise<Map<string, string>> {
    const refToId = new Map<string, string>();
    for (const planned of manifest.databases) {
      const dbId = dbIds.get(norm(planned.name));
      if (!dbId) continue;
      refToId.set(dbRef(planned.name), dbId);

      const detail = await this.databases.get(membership, dbId);
      for (const field of detail.fields as unknown as LiveField[]) {
        refToId.set(fieldRef(planned.name, field.displayName), field.id);
        for (const option of field.options ?? []) {
          refToId.set(optionRef(planned.name, field.displayName, option.label), option.id);
        }
      }
    }
    return refToId;
  }

  private resolveDb(dbIds: Map<string, string>, name: string, what: string): string {
    const id = dbIds.get(norm(name));
    if (!id) {
      throw new UnprocessableEntityException(
        `${what} belongs to a database "${name}" that the manifest does not declare.`,
      );
    }
    return id;
  }

  private async liveFields(membership: Membership, databaseId: string): Promise<LiveField[]> {
    const detail = await this.databases.get(membership, databaseId);
    return detail.fields as unknown as LiveField[];
  }

  private async installDerivedFields(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
    result: PackInstallResult,
  ): Promise<void> {
    if (manifest.derived_fields.length === 0) return;
    // Read after the Architect built the relations these configs point at.
    const refToId = await this.readInstallRefs(membership, manifest, dbIds);

    for (const planned of manifest.derived_fields) {
      const label = `${planned.database}.${planned.name}`;
      const dbId = this.resolveDb(dbIds, planned.database, `The ${planned.type} field "${label}"`);
      const live = await this.liveFields(membership, dbId);
      const existing = live.find((f) => norm(f.displayName) === norm(planned.name));
      if (existing) {
        result.derived_fields.push({ name: label, action: 'reused', id: existing.id });
        continue;
      }
      const config = deref(planned.config, refToId, `The ${planned.type} field "${label}"`);
      const created = (await this.fields.create(dbId, {
        display_name: planned.name,
        type: planned.type,
        config: config as Record<string, unknown>,
      })) as unknown as LiveField;
      result.derived_fields.push({ name: label, action: 'created', id: created.id });
    }
  }

  private async installViews(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
    refToId: Map<string, string>,
    result: PackInstallResult,
    resolutions: Map<string, PackInstallResolutions[string]> = new Map(),
    hashes: Map<string, string> = new Map(),
    untracked: Set<string> = new Set(),
  ): Promise<void> {
    for (const planned of manifest.views) {
      const label = `${planned.database}.${planned.name}`;
      const resolution = resolutions.get(label);
      if (resolution?.action === 'skip') {
        result.views.push({ name: label, action: 'skipped', id: '' });
        continue;
      }
      const targetName = resolution?.action === 'rename' ? resolution.rename_to! : planned.name;

      const dbId = this.resolveDb(dbIds, planned.database, `The view "${label}"`);
      const detail = await this.databases.get(membership, dbId);
      const existing = ((detail as unknown as { views: LiveView[] }).views ?? []).find(
        (v) => norm(v.name) === norm(targetName),
      );
      if (existing) {
        result.views.push({ name: label, action: 'reused', id: existing.id });
        // The database's default ("All records") is scaffolding every
        // database has, not pack content — never hashed, never tracked as a
        // pack_install_item (see `untracked`'s callers: `recordInstall` skips
        // it, so `uninstall` never considers deleting it and the "a database
        // must keep at least one view" invariant can never be in play).
        if (existing.isDefault) {
          untracked.add(existing.id);
        } else {
          hashes.set(
            `view:${existing.id}`,
            this.hashOf({ name: existing.name, type: existing.type, config: existing.config }),
          );
        }
        continue;
      }

      // THE rewrite. Without it a view installs carrying the *source*
      // workspace's field ids: it validates, it saves, and it groups by nothing.
      const config = deref(planned.config, refToId, `The view "${label}"`);
      // Through the ordinary validated create, so a pack cannot install a view a
      // person could not — `ViewsService.create` re-checks the config against
      // this database's live fields, which is also what catches a manifest whose
      // refs resolved to the wrong types.
      const created = await this.views.create(
        dbId,
        {
          name: targetName,
          type: planned.type,
          config: config as never,
        },
        membership.userId,
      );
      result.views.push({ name: label, action: 'created', id: created.id });
      hashes.set(
        `view:${created.id}`,
        this.hashOf({ name: targetName, type: planned.type, config }),
      );
    }
  }

  private async installAutomations(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
    refToId: Map<string, string>,
    result: PackInstallResult,
    resolutions: Map<string, PackInstallResolutions[string]> = new Map(),
    hashes: Map<string, string> = new Map(),
  ): Promise<void> {
    for (const planned of manifest.automations) {
      const label = `${planned.database}.${planned.name}`;
      const resolution = resolutions.get(label);
      if (resolution?.action === 'skip') {
        result.automations.push({ name: label, action: 'skipped', id: '' });
        continue;
      }
      const targetName = resolution?.action === 'rename' ? resolution.rename_to! : planned.name;

      const dbId = this.resolveDb(dbIds, planned.database, `The automation "${label}"`);
      const { data } = await this.automations.list(dbId);
      const existing = data.find((r) => norm(r.name) === norm(targetName));
      if (existing) {
        result.automations.push({ name: label, action: 'reused', id: existing.id });
        hashes.set(
          `automation:${existing.id}`,
          this.hashOf({
            name: existing.name,
            trigger: existing.trigger,
            condition: existing.condition,
            actions: existing.actions,
            enabled: existing.enabled,
          }),
        );
        continue;
      }

      const where = `The automation "${label}"`;
      const trigger = deref(planned.trigger, refToId, where);
      const condition = planned.condition ? deref(planned.condition, refToId, where) : undefined;
      const actions = deref(planned.actions, refToId, where);
      const created = await this.automations.create(
        membership.workspaceId,
        dbId,
        {
          name: targetName,
          trigger: trigger as never,
          condition,
          actions: actions as never,
          enabled: planned.enabled,
        },
        membership.userId,
      );
      result.automations.push({ name: label, action: 'created', id: created.id });
      hashes.set(
        `automation:${created.id}`,
        this.hashOf({ name: targetName, trigger, condition, actions, enabled: planned.enabled }),
      );
    }
  }

  /**
   * Sample records, matched by title.
   *
   * Weaker than the rest: two sample records could legitimately share a title,
   * and this would collapse them on re-install. It is the right trade anyway —
   * a re-install that silently doubles the sample data is the failure people
   * actually hit, and sample records are illustrative by definition.
   */
  private async installSampleRecords(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
    refToId: Map<string, string>,
    result: PackInstallResult,
  ): Promise<void> {
    if (manifest.sample_records.length === 0) return;

    // Titles read once per database, not once per record: the scan is the same
    // 200 rows every time, and a manifest may carry dozens of samples.
    // Newly-created titles are added as we go, so two samples sharing a title
    // within one manifest collapse the same way a re-install does.
    const titles = new Map<string, Map<string, string>>();
    const titlesFor = async (dbId: string): Promise<Map<string, string>> => {
      const cached = titles.get(dbId);
      if (cached) return cached;
      const { data } = await this.records.list(dbId, { limit: MAX_SCAN });
      const map = new Map(data.map((r) => [norm(r.title), r.id] as const));
      titles.set(dbId, map);
      return map;
    };

    for (const planned of manifest.sample_records) {
      const dbId = this.resolveDb(dbIds, planned.database, 'A sample record');
      const title = String(planned.values['name'] ?? '');
      const label = `${planned.database}: ${title || '(untitled)'}`;

      const known = await titlesFor(dbId);
      const existing = known.get(norm(title));
      if (existing) {
        result.sample_records.push({ name: label, action: 'reused', id: existing });
        continue;
      }
      const values = deref(planned.values, refToId, `A sample record of "${planned.database}"`);
      const created = await this.records.create(
        membership.workspaceId,
        dbId,
        values as Record<string, unknown>,
        membership.userId,
        0,
      );
      known.set(norm(title), created.id);
      result.sample_records.push({ name: label, action: 'created', id: created.id });
    }
  }

  /**
   * Every `agents[].skills` name must resolve to a bundled `skills[].name`.
   *
   * A manifest is meant to be edited by hand between export and install (that
   * is the whole point of it being plain JSON/YAML), and `agents[].skills` is
   * exactly the kind of thing an author adds after the fact — export always
   * emits it empty (see `exportAgents`), since there is no live relation to
   * read it from. Checked up front, before anything is built, for the same
   * reason `deref` throws on an unresolved `$ref`: a name that does not
   * resolve is the manifest lying about its own contents, not a soft warning.
   */
  private validateAgentSkillNames(manifest: PackManifest): void {
    const bundled = new Set(manifest.skills.map((s) => norm(s.name)));
    for (const agent of manifest.agents) {
      for (const name of agent.skills) {
        if (!bundled.has(norm(name))) {
          throw new UnprocessableEntityException(
            `Agent "${agent.name}" declares skill "${name}", which this pack does not bundle. ` +
              `Every name in an agent's \`skills\` must match a \`skills[].name\` in the same manifest.`,
          );
        }
      }
    }
  }

  /**
   * Skills (#40), matched and installed by name.
   *
   * Workspace-wide rather than per-database like everything else install
   * touches, so idempotency is a single name lookup rather than a per-database
   * scan (contrast `installSampleRecords`'s `titlesFor`): visible-to-caller
   * skills are read once, and a bundled skill whose name already exists —
   * personal or shared, owned by anyone — is reused rather than duplicated.
   * Installed as `shared`: a pack is a team artifact, and a skill nobody but
   * the installing admin could see would defeat the point of bundling it.
   */
  private async installSkills(
    membership: Membership,
    manifest: PackManifest,
    result: PackInstallResult,
    hashes: Map<string, string> = new Map(),
  ): Promise<void> {
    if (manifest.skills.length === 0) return;

    const skillProjection = (s: {
      name: string;
      description: string;
      when_to_use: string;
      instructions: string;
      examples: unknown;
      allowed_tools: unknown;
    }) => ({
      name: s.name,
      description: s.description,
      when_to_use: s.when_to_use,
      instructions: s.instructions,
      examples: s.examples,
      allowed_tools: s.allowed_tools,
    });

    const { data: visible } = await this.skills.list(membership, membership.userId);
    const byName = new Map(visible.map((s) => [norm(s.name), s] as const));

    for (const planned of manifest.skills) {
      const existing = byName.get(norm(planned.name));
      if (existing) {
        result.skills.push({ name: planned.name, action: 'reused', id: existing.id });
        hashes.set(`skill:${existing.id}`, this.hashOf(skillProjection(existing)));
        continue;
      }
      const created = await this.skills.create(membership, membership.userId, {
        name: planned.name,
        description: planned.description,
        when_to_use: planned.when_to_use,
        instructions: planned.instructions,
        examples: planned.examples,
        allowed_tools: planned.allowed_tools,
        visibility: 'shared',
      });
      byName.set(norm(created.name), created);
      result.skills.push({ name: planned.name, action: 'created', id: created.id });
      hashes.set(`skill:${created.id}`, this.hashOf(skillProjection(created)));
    }
  }
}
