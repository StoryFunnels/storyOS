import { ConflictException, HttpException, Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { stripPublicSharing } from '../views/view-sharing';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  blocksToMarkdown,
  compareSemver,
  creatableFieldTypeSchema,
  dbRef,
  fieldRef,
  lineDiff,
  optionRef,
  PACK_REF_PATTERN,
  packExportRequestSchema,
  describeManifestIssues,
  packManifestSchema,
  resolveSampleDate,
  installedEnabledState,
  SAMPLE_ME,
  type PlanOption,
} from '@storyos/schemas';
import type {
  PackAgent,
  PackAgentUpdate,
  PackAiNeed,
  PackDatabaseGains,
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
import {
  agentWriteGates,
  automations as automationsTable,
  databases as databasesTable,
  fields as fieldsTable,
  packInstallItems,
  packInstalls,
  records as recordsTable,
  selectOptions,
  sources,
  spaces as spacesTable,
  views as viewsTable,
  workspaces,
} from '../db/schema';
import { redactSecrets } from '../common/redact-secrets';
import { AgentsService } from '../agents/agents.service';
import { ArchitectService, type ArchitectBuildProgress } from '../agents/architect.service';
import { decideField, decideState, relationExists } from '../agents/plan-decisions';
import { AutomationsService } from '../automations/automations.service';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SkillsService } from '../skills/skills.service';
import { RUN_CLASS_BY_LABEL } from '../agents/agent-runtime';
import { ViewsService } from '../views/views.service';
import { ACCESS_RANK, AccessService } from '../access/access.service';
import type { EffectiveRole } from '../access/access.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { trackSampleRecords, untrackSampleRecords } from '../workspaces/sample-records';
import { MarketplaceService } from './marketplace.service';
import { deref, findRawUuids, refify } from './pack-refs';

/** How many records a scan of a system database reads. Mirrors ArchitectService. */
const MAX_SCAN = 200;

const norm = (s: string) => s.trim().toLowerCase();

/** Marks a sample-value token that matched nothing (#1015). */
const SAMPLE_UNRESOLVED = Symbol('sample-unresolved');

/** #977 — what an update would do to one tracked agent, and what is needed to do it. */
interface AgentUpdatePlan {
  update: PackAgentUpdate;
  recordId: string;
  /** The values to write when the update is applied (pack-defined parts only). */
  values: Record<string, unknown>;
  /** Hash of the PACK's content for this agent, in the same normalised form `source_hash` stores. */
  newHash: string;
  /** ticket #1106: the hash when everything BUT a changed AI mode was applied (the person kept their mode). Set only with `ai_mode_change`. */
  newHashWithoutMode?: string;
  /** ticket #1106: nothing but the AI mode makes this agent need a choice. */
  restUntouched?: boolean;
  /** What the install row held before this run — preserved when the person's edits are kept. */
  previous: { packVersion: string | null; sourceHash: string | null };
}

/** `pack_install_items` provenance for an agent, keyed by normalised agent name. */
type AgentProvenance = Map<string, { packVersion: string | null; sourceHash: string | null }>;

const AGENT_CONTENT_FIELDS = ['goal', 'instructions', 'scopes', 'approval_policy', 'ai_mode', 'skills'] as const;

/** #266 — every `$db:`/`$field:`/`$option:` ref anywhere inside a value,
 *  walked the same generic way `refify`/`deref` do (any string, any depth,
 *  including object keys — see pack-refs.ts's own header on why). */
function findPackRefs(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      if (PACK_REF_PATTERN.test(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) {
        if (PACK_REF_PATTERN.test(key)) out.push(key);
        walk(val);
      }
    }
  };
  walk(value);
  return out;
}

/**
 * #266 — `$db:`/`$field:`/`$option:` refs are derived from the database's
 * NAME at export time (`dbRef`/`fieldRef`/`optionRef`) and baked as literal
 * strings into every view/derived-field/automation/sample-record config —
 * `deref` on install recomputes `refToId` from the manifest's CURRENT name
 * (`readInstallRefs`), so renaming `databases[0].name` alone leaves every
 * embedded ref pointing at a ref string install will never construct.
 * Mirrors `refify`'s own object-key-aware walk (`pack-refs.ts`'s header
 * explains why: `column_widths` is keyed by a ref, not just valued by one).
 */
function remapRefStrings(value: unknown, oldToNewRef: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return oldToNewRef.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapRefStrings(v, oldToNewRef));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [oldToNewRef.get(key) ?? key, remapRefStrings(val, oldToNewRef)]),
    );
  }
  return value;
}

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
  options?: Array<{ id: string; label: string; color?: string; category?: string | null }>;
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

/** #1112 — everything an install has created so far; `result` exists once the architect walk has returned. */
interface InstallLedger {
  built: ArchitectBuildProgress;
  result?: PackInstallResult;
}

/** #1112 — what existed before an install could provision the Agentic OS space and databases. */
interface AgentOsSnapshot {
  databaseIds: Set<string>;
  spaceIds: Set<string>;
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
/** #1156 — what the preview says about a same-named database in another space (see `packPreviewItemSchema.existing_elsewhere`). */
type ExistingElsewhere = { database_id?: string; space_name?: string; adopted: boolean; reusable: boolean; reason?: string };

/** "A", "A and B", "A, B and C": the names, once each, in a stable order. */
function readableList(names: string[]): string {
  const uniq = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return uniq.length <= 1 ? (uniq[0] ?? '') : `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
}
/** The words for a field type in a sentence: `multi_select` -> "a multi select", `email` -> "an email". */
function typeWords(type: string): string {
  const t = type.replace(/_/g, ' ');
  return `${/^[aeiou]/i.test(t) ? 'an' : 'a'} ${t}`;
}
const typeClash = (field: string, liveType: string, plannedType: string) =>
  `${field} is ${typeWords(liveType)} here but this pack needs ${typeWords(plannedType)}`;
/** Said for a database that does not exist, that the person cannot read, AND one they can read but not edit: one wording, so none is confirmed. */
const notFoundReason = (dbName: string) => `There is no ${dbName} database you can edit.`;
/** Only databases the person can EDIT are counted and named, so a hidden or read-only one never appears here. */
const ambiguousReason = (dbName: string, spaceNames: string[]) =>
  `Can't use one: you have more than one ${dbName} database (in ${readableList(spaceNames)}). Create a new one here.`;

@Injectable()
export class PacksService {
  private readonly logger = new Logger(PacksService.name);

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
    private readonly access: AccessService,
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
    // Ticket #1096: an EXPORT reads the workspace, it must not provision the Agentic OS pack. A workspace that never had one has
    // no agents and no bindings, so the manifest simply carries none.
    const { agentsDb, triggersDb } = await this.agents.findPackDbs(membership.workspaceId);
    const bindings = triggersDb ? await this.records.list(triggersDb.id, { limit: MAX_SCAN }) : { data: [] as Array<{ id: string; values: Record<string, unknown> }> };

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
              // #1105 — round-trips: an exported manifest keeps the categories its options carry (a select option without one stays without)
              ...(o.category ? { category: o.category as PlanOption['category'] } : {}),
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
            // #1105 — a workflow field's categories round-trip too (a person may have changed them after install)
            ...(o.category ? { category: o.category as PlanOption['category'] } : {}),
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
    const { agents, triggers } = agentsDb
      ? await this.exportAgents(membership, slice, agentsDb.id, bindings.data)
      : { agents: [], triggers: [] };
    const views = this.exportViews(slice, idToRef);
    const automations = await this.exportAutomations(slice, idToRef);
    const sampleRecords = request.include_sample_records
      ? await this.exportSampleRecords(slice, idToRef, request.sample_limit)
      : [];
    const skills = await this.exportSkills(membership, [...request.skill_ids, ...(await this.agentSkillIds(membership, agents, request.skill_ids))]);

    const manifest: PackManifest = packManifestSchema.parse({
      format_version: 1,
      slug: request.slug,
      name: request.name,
      version: request.version,
      upgrade_notes: request.upgrade_notes,
      why: request.why,
      can: request.can,
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

  // ── duplicate ────────────────────────────────────────────────────────────

  /**
   * #266 — "duplicate database" is export→rename→install of a ONE-database
   * slice, not a second copier. See the ticket's own grounding: `export()`
   * already accepts `database_ids: [oneId]` (item 1), and `refify`/`deref`
   * already remap every field/option id a view, a formula or a select value
   * touches (item 3) — nothing here re-implements that walk.
   *
   * Three things this orchestration adds on top of the raw export/install
   * round trip, because none of them are `install()`'s job:
   *
   * 1. RENAME BEFORE INSTALL. `ArchitectService.buildDatabases` matches an
   *    existing database purely by `norm(name)`, workspace-wide — "action:
   *    create" in the plan is advisory only (architect.service.ts). Install
   *    the manifest under the SOURCE's own name and it does not create a
   *    copy, it REUSES the source and merges the "new" fields/views into it.
   *    So the target name is decided and validated for uniqueness BEFORE
   *    `install()` ever sees the manifest, and every `database:`-labeled
   *    string in it (views/derived_fields/automations/sample_records) plus
   *    `relations[].from`/`.to` (a self-relation names the source twice) is
   *    rewritten to match — these are plain name strings, not `$ref`s, so a
   *    straight replace is correct.
   *
   * 2. DROP DERIVED FIELDS THAT DEPENDED ON A SKIPPED RELATION, AND REPORT
   *    IT. A single-database export already drops any relation whose other
   *    side isn't in the slice (`exportRelations`, silently — see that
   *    method's own comment) — cross-database relations never survive a
   *    duplicate. A lookup/rollup's `relation_field_id` ref survives refify
   *    (it names a field on the SOURCE side, which is always in-slice), so
   *    export succeeds — but the field it points at is never recreated, and
   *    `deref` at install time would 422 on the dangling ref. Rather than let
   *    that surface as an install failure, this computes the exact set of
   *    refs the renamed manifest WILL be able to resolve (every plain field,
   *    every relation's two recreated fields) and drops any derived field
   *    whose config references something outside it — reported, not silent,
   *    per the ticket's criterion 6.
   *
   * 3. NO PACK PROVENANCE LEFT BEHIND. `install()` unconditionally writes a
   *    `pack_installs` row (`recordInstall`) — there is no flag to skip it.
   *    A duplicated database is not an installed pack and must not appear in
   *    "installed packs"; the bookkeeping row (and its cascaded items) is
   *    deleted immediately after install succeeds, once its job — driving
   *    `ArchitectService.build` — is done.
   *
   * Records are copied through the SAME sample-record mechanism
   * `include_sample_records` already uses when `opts.include_records` is
   * set — capped at `sample_limit`'s own max (50) and limited to
   * `PORTABLE_VALUE_TYPES` (relation/user/attachment values are never
   * copied, matching what the pack format already promises everywhere
   * else). A duplicate with more than 50 records, or relation/user/
   * attachment-valued records, copies its SCHEMA completely and its first
   * 50 portable-valued records — reported on the result rather than
   * silently truncated, so the caller can tell "everything came along" from
   * "the common case did".
   */
  async duplicateDatabase(
    membership: Membership,
    databaseId: string,
    opts: { name?: string; include_records?: boolean } = {},
  ): Promise<{
    id: string;
    name: string;
    records_copied: number;
    skipped_relations: string[];
    skipped_derived_fields: Array<{ name: string; reason: string }>;
  }> {
    const { database: source } = await this.databases.assertAccess(membership, databaseId, 'creator');

    const targetName = await this.uniqueDuplicateName(membership, opts.name?.trim() || `${source.name} copy`);

    const slug = `duplicate-${createHash('sha1').update(`${databaseId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
    const manifest = await this.export(membership, {
      slug,
      name: targetName,
      version: '1.0.0',
      summary: `Duplicate of "${source.name}"`,
      database_ids: [databaseId],
      include_sample_records: Boolean(opts.include_records),
      sample_limit: 50,
    });

    // Every relation field this database actually has, so we can report which
    // ones a single-database slice could never carry (its other side is, by
    // definition, outside the slice unless it's a self-relation).
    const sourceRelationFields = await this.db.query.fields.findMany({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.type, 'relation'), isNull(fieldsTable.deletedAt)),
      columns: { displayName: true },
    });
    const carriedFieldNames = new Set(
      manifest.relations.flatMap((r) => [
        ...(r.from === source.name ? [r.from_field] : []),
        ...(r.to === source.name ? [r.to_field] : []),
      ]),
    );
    const skippedRelations = sourceRelationFields
      .map((f) => f.displayName)
      .filter((name) => !carriedFieldNames.has(name));

    // The refs the RENAMED manifest will actually be able to resolve at
    // install time: every plain field it declares, plus the two field ends
    // of every relation it kept. Anything a derived field's config points at
    // outside this set would 422 on `deref` — dropped here instead, reported
    // on the result.
    const resolvable = new Set<string>();
    for (const db of manifest.databases) {
      resolvable.add(dbRef(db.name));
      for (const field of db.fields) {
        resolvable.add(fieldRef(db.name, field.name));
        for (const option of field.options ?? []) resolvable.add(optionRef(db.name, field.name, option.label));
      }
    }
    for (const relation of manifest.relations) {
      resolvable.add(fieldRef(relation.from, relation.from_field));
      resolvable.add(fieldRef(relation.to, relation.to_field));
    }

    const skippedDerivedFields: Array<{ name: string; reason: string }> = [];
    manifest.derived_fields = manifest.derived_fields.filter((field) => {
      const refs = findPackRefs(field.config);
      const missing = refs.find((ref) => ref.startsWith('$field:') && !resolvable.has(ref));
      if (!missing) return true;
      skippedDerivedFields.push({
        name: field.name,
        reason: `depended on a relation this duplicate could not carry over (${missing})`,
      });
      return false;
    });

    // Rename, in two parts:
    //
    // (a) every `$db:`/`$field:`/`$option:` ref STRING baked into a config —
    //     these are derived from the OLD name and install's `deref` rebuilds
    //     `refToId` from the manifest's post-rename name, so a ref left
    //     unrewritten here points at a string install will never construct
    //     (see `remapRefStrings`'s own doc — this is what #option:… 422s
    //     without it).
    // (b) every `database:`-labeled plain string, plus a self-relation's
    //     from/to (both name the source, since a self-relation's two sides
    //     are the same database) — these are plain names matched by
    //     `norm()`, not refs, so a straight replace is correct.
    const oldToNewRef = new Map<string, string>();
    for (const db of manifest.databases) {
      oldToNewRef.set(dbRef(db.name), dbRef(targetName));
      for (const field of db.fields) {
        oldToNewRef.set(fieldRef(db.name, field.name), fieldRef(targetName, field.name));
        for (const option of field.options ?? []) {
          oldToNewRef.set(optionRef(db.name, field.name, option.label), optionRef(targetName, field.name, option.label));
        }
      }
    }
    for (const relation of manifest.relations) {
      if (relation.from === source.name) oldToNewRef.set(fieldRef(relation.from, relation.from_field), fieldRef(targetName, relation.from_field));
      if (relation.to === source.name) oldToNewRef.set(fieldRef(relation.to, relation.to_field), fieldRef(targetName, relation.to_field));
    }

    manifest.views = manifest.views.map((v) => ({ ...v, config: remapRefStrings(v.config, oldToNewRef) as typeof v.config }));
    manifest.derived_fields = manifest.derived_fields.map((f) => ({
      ...f,
      config: remapRefStrings(f.config, oldToNewRef) as typeof f.config,
    }));
    manifest.automations = manifest.automations.map((a) => ({
      ...a,
      trigger: remapRefStrings(a.trigger, oldToNewRef) as typeof a.trigger,
      condition: a.condition !== undefined ? remapRefStrings(a.condition, oldToNewRef) : a.condition,
      actions: a.actions.map((act) => remapRefStrings(act, oldToNewRef)) as typeof a.actions,
    }));
    manifest.sample_records = manifest.sample_records.map((r) => ({
      ...r,
      values: remapRefStrings(r.values, oldToNewRef) as typeof r.values,
    }));

    manifest.databases[0]!.name = targetName;
    for (const view of manifest.views) if (view.database === source.name) view.database = targetName;
    for (const field of manifest.derived_fields) if (field.database === source.name) field.database = targetName;
    for (const automation of manifest.automations) if (automation.database === source.name) automation.database = targetName;
    for (const record of manifest.sample_records) if (record.database === source.name) record.database = targetName;
    for (const relation of manifest.relations) {
      if (relation.from === source.name) relation.from = targetName;
      if (relation.to === source.name) relation.to = targetName;
    }
    // #525 — this rename loop covered views/derived_fields/automations/
    // sample_records/relations but missed states and triggers, so a database
    // with a workflow-state select field bound to an agent trigger failed
    // install() validation entirely ("a state/trigger refers to a database
    // ... that the plan does not declare") before collision detection was
    // even reached. `states` is a SEPARATE manifest section from `databases`
    // — a select field used as a trigger's state gets pulled out of its
    // database's plain field list into `states` (export()'s own comment on
    // ADR-0010 §5), so it carries its own `database` name to rename.
    for (const state of manifest.states) if (state.database === source.name) state.database = targetName;
    for (const trigger of manifest.triggers) if (trigger.database === source.name) trigger.database = targetName;

    // #525 — a duplicate's agent triggers name Agents that already exist in
    // THIS SAME workspace by construction (the source database's own
    // bindings, exported by name per exportAgents/#161's identity scheme).
    // computeCollisions has no way to know that; it sees a live Agent with
    // this name and — correctly, for a genuine external pack — calls it a
    // collision requiring a person's decision. That decision isn't real
    // here: ArchitectService.buildAgents already reuses an existing Agent by
    // name (applyResolutions' 'reuse' branch for agents is a no-op that
    // relies entirely on that), so every agent collision in a same-workspace
    // duplicate is pre-resolved to 'reuse' rather than left to 409.
    const agentResolutions: PackInstallResolutions = Object.fromEntries(
      manifest.agents.map((a) => [a.name, { action: 'reuse' as const }]),
    );
    const result = await this.install(membership, manifest, agentResolutions);

    // #266.3 — a duplicate is not an installed pack; strip the provenance
    // `install()` always writes. Cascades to pack_install_items.
    await this.db.delete(packInstalls).where(and(eq(packInstalls.workspaceId, membership.workspaceId), eq(packInstalls.slug, slug)));

    const newDb = result.databases.find((d) => norm(d.name) === norm(targetName));
    if (!newDb) {
      throw new UnprocessableEntityException('Duplicate install did not report the new database — this is a bug.');
    }

    return {
      id: newDb.id,
      name: targetName,
      records_copied: result.sample_records.length,
      skipped_relations: skippedRelations,
      skipped_derived_fields: skippedDerivedFields,
    };
  }

  /** `${base}`, then `${base} 2`, `${base} 3`, … — the first name no live
   *  database in the workspace already has, matched the SAME way
   *  `ArchitectService.buildDatabases` matches (`norm`: trim + lowercase). */
  private async uniqueDuplicateName(membership: Membership, base: string): Promise<string> {
    const live = await this.databases.list(membership);
    const taken = new Set(live.map((d) => norm(d.name)));
    if (!taken.has(norm(base))) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base} ${i}`;
      if (!taken.has(norm(candidate))) return candidate;
    }
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
  /**
   * ticket #1106 — the ids of skills the exported agents NAME that the caller did not already list in `skill_ids`, so an agent's skills
   * travel with it (the manifest would otherwise fail install's "every agent skill is bundled" rule). A named skill the caller cannot
   * see is a 422 naming it: exporting without it would produce an agent that fails every run.
   */
  private async agentSkillIds(membership: Membership, agents: PackAgent[], alreadyIds: string[]): Promise<string[]> {
    const wanted = [...new Set(agents.flatMap((a) => a.skills.map((n) => norm(n))))];
    if (wanted.length === 0) return [];
    const { data: visible } = await this.skills.list(membership, membership.userId);
    const have = new Set(alreadyIds);
    const have_names = new Set(visible.filter((s) => have.has(s.id)).map((s) => norm(s.name)));
    const out: string[] = [];
    for (const name of wanted) {
      if (have_names.has(name)) continue;
      const found = visible.find((s) => norm(s.name) === name);
      if (!found) {
        throw new UnprocessableEntityException(
          `An exported agent uses the skill "${name}", which this workspace cannot see (removed, renamed, or someone else's personal skill). ` +
            `Restore it, or take it off the agent's Skills field, then export again.`,
        );
      }
      out.push(found.id);
    }
    return out;
  }

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
      // #317: by flag, not by name — a user's own database called "Runs" is
      // theirs and belongs in the pack they are exporting.
      if (db.isSystem) continue;
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
  /** `{ ai_mode }` for a live "AI mode" label, or `{}` when it is unset (or not one of the three). */
  private exportedAiMode(label: string | null): { ai_mode?: PackAgent['ai_mode'] } {
    const mode = label ? RUN_CLASS_BY_LABEL[label] : undefined;
    return mode ? { ai_mode: mode } : {};
  }

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

    // #1104 — the per-agent write gates, by database/field NAME. Absent for an agent with none, so an ungated agent exports exactly as before.
    const gatesByAgent = await this.architect.exportWriteGates(
      membership.workspaceId,
      [...wantedAgentIds],
      new Map([...byId].map(([id, d]) => [id, { name: d.name, fields: d.fields }])),
    );

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
        ...(gatesByAgent.has(id) ? { write_gates: gatesByAgent.get(id) } : {}),
        // ticket #1106: the agent's own "Skills" field, one name per line. `export` bundles each named skill (below) so the manifest
        // still satisfies install's "every agent skill is bundled" rule.
        skills: String(row.values['skills'] ?? '')
          .split('\n')
          .map((n) => n.trim())
          .filter(Boolean),
        // The mode only when one is SET: an unset mode exports as omitted, so a round trip leaves an agent the pack never configured alone.
        ...this.exportedAiMode(labelOf('ai_mode', row.values['ai_mode'])),
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
        // #1041 — a pack is a template, not a published form: no token, no published-view block travels with it.
        config: refify(
          stripPublicSharing((view.config ?? {}) as Record<string, unknown>),
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
   * #1095 — validate "install into this existing space" and return it, BEFORE anything is built.
   *
   *  - The space must be one the caller may see and EDIT: a missing, deleted or other-workspace space and someone else's personal
   *    space are all the same 404; viewing without editing is a 403 (the rule `databases.create` already applies).
   *  - Not a PERSONAL space: a personal space holds documents and views only, never databases (personal-space.md).
   *  - A manifest whose databases sit in more than one space is refused: "everything lands in the target" would flatten a structure
   *    the pack chose on purpose, and picking which space the target stands in for would be a guess.
   *  - A manifest database of the same name in a DIFFERENT space is no business of this install (#1156): it used to be reused where it
   *    lived, which left the target space without it, so #1095 refused it (409). Matching is now scoped to the target space, so the pack
   *    simply creates its own here and the refusal is gone. In the target space itself a same-named database is reused if this pack put
   *    it there (idempotent) and is a collision needing a decision if it did not (`computeCollisions`).
   */
  private async resolveTargetSpace(
    membership: Membership,
    manifest: PackManifest,
    targetSpaceId: string,
  ): Promise<{ id: string; name: string }> {
    await this.access.assertSpaceDoor(membership, targetSpaceId);
    const space = await this.access.assertSpace(membership, targetSpaceId, 'editor');
    if (space.personal) {
      throw new UnprocessableEntityException('A pack cannot be installed into a personal space: it holds documents and views, not databases.');
    }
    const planned = [...new Set(manifest.databases.map((d) => norm(d.space)))];
    if (planned.length > 1) {
      const names = [...new Set(manifest.databases.map((d) => d.space))].join(', ');
      throw new UnprocessableEntityException(
        `"${manifest.name}" places its databases in ${planned.length} spaces (${names}), so it cannot be installed into one existing space. Install it without choosing a space.`,
      );
    }
    return { id: space.id, name: space.name };
  }

  /**
   * #1156 — which databases in OTHER spaces this install adopts, and what the review should say about each.
   *
   * Matching is per space, so a database of the same name elsewhere is ignored by default. Sharing one across packs (a Clients list for
   * Agency OS, Consulting OS and a portal) is a deliberate act, so it happens only when
   *  - the person chose `reuse` for that database in the review (`resolutions`), or
   *  - this pack adopted it on an earlier install (tracked as `reused`), so a re-install keeps using it instead of making a duplicate.
   * It must also be REUSABLE: the person can EDIT exactly one database of that name, and its fields fit the pack (same type where the
   * pack declares a field; a workflow state is a select). Why not is worded for a person (`reuseReasons`).
   *
   * Only what the person can READ is ever looked at (`my_access` comes from the visibility-filtered list). A database they can read but
   * not edit gets the not-found wording, with no id or space; one they cannot read leaves no trace at all. The ambiguity reason counts and
   * names only databases they can edit. `strict` (install) refuses an explicit `reuse` that is not reusable with the reason as the
   * message; the preview (not strict) reports the same reason instead, so the review can show it and the install agrees with it.
   */
  private async planAdoptions(
    membership: Membership,
    manifest: PackManifest,
    targetSpaceId: string | undefined,
    resolutions: PackInstallResolutions,
    existingInstall: { id: string } | undefined,
    strict = true,
  ): Promise<{ adopt: Map<string, { id: string; name: string }>; hints: Map<string, ExistingElsewhere> }> {
    const adopt = new Map<string, { id: string; name: string }>();
    const hints = new Map<string, ExistingElsewhere>();
    const trackedDbIds = existingInstall ? await this.trackedDatabaseIds(existingInstall.id) : new Map<string, string>();
    const inHomeSpace = await this.architect.homeSpaceMatcher(membership, targetSpaceId ? { id: targetSpaceId } : undefined, trackedDbIds);
    const live = await this.databases.list(membership);
    const spaceNames = new Map((await this.spaces.list(membership)).map((s) => [s.id, s.name] as const));
    const where = (spaceId: string) => spaceNames.get(spaceId) ?? 'another space';
    const trackedDbs = existingInstall
      ? await this.db.query.packInstallItems.findMany({
          where: and(eq(packInstallItems.packInstallId, existingInstall.id), eq(packInstallItems.kind, 'database')),
        })
      : [];
    const canEdit = (d: { my_access: string | null }) => d.my_access !== null && ACCESS_RANK[d.my_access as EffectiveRole] >= ACCESS_RANK.editor;
    // #1157 — the databases this install tracked that are still live (not trashed) and that the installer can EDIT; anything else is
    // treated as absent, so nothing about a database they cannot edit is used or described.
    const trackedLive = trackedDbs.flatMap((t) => {
      const l = live.find((x) => x.id === t.entityId && canEdit(x));
      return l ? [{ t, l }] : [];
    });
    // A tracked database that this pack CREATED is found by id wherever it lives now, but only when this is a re-install INTO where the
    // pack lives: no explicit target, or a target that still holds at least one of them. A target that holds none is the person
    // installing somewhere else, which builds a new set there (#1156). One this pack ADOPTED (`reused`) is kept either way (#1156).
    const anchored = !targetSpaceId || trackedLive.some((x) => x.l.spaceId === targetSpaceId);
    for (const d of manifest.databases) {
      const home = inHomeSpace(d.name, d.space);
      const earlier = trackedLive.find((x) => norm(x.t.name) === norm(d.name) && (x.t.action === 'reused' || anchored));
      const kept = earlier?.l;
      if (kept && home?.id === kept.id) continue; // already where the name match would find it
      if (!kept && home) {
        // A same-named database the install did not create (its id is not the tracked one), in the space it installs into: written to only
        // on the person's explicit `reuse`, and then only if they can edit it, worded as for a database that is not there (#1156).
        const foreign = trackedDbIds.get(norm(d.name)) !== home.id;
        if (foreign && strict && resolutions[d.name]?.action === 'reuse' && !canEdit(home)) {
          throw new UnprocessableEntityException(notFoundReason(d.name));
        }
        continue;
      }
      if (kept) {
        adopt.set(norm(d.name), { id: kept.id, name: kept.name });
        hints.set(norm(d.name), { database_id: kept.id, space_name: where(kept.spaceId), adopted: true, reusable: true });
        continue;
      }
      const same = live.filter((x) => norm(x.name) === norm(d.name) && !x.isSystem);
      const editable = same.filter(canEdit);
      const chose = resolutions[d.name]?.action === 'reuse';
      let hint: ExistingElsewhere | undefined;
      if (editable.length > 1) {
        hint = { adopted: false, reusable: false, reason: ambiguousReason(d.name, editable.map((x) => where(x.spaceId))) };
      } else if (editable.length === 1) {
        const only = editable[0]!;
        const reason = await this.incompatibility(membership, manifest, d.name, only.id);
        hint = { database_id: only.id, space_name: where(only.spaceId), adopted: chose && !reason, reusable: !reason, ...(reason ? { reason } : {}) };
        if (chose && !reason) adopt.set(norm(d.name), { id: only.id, name: only.name });
      } else if (same.length > 0) {
        hint = { adopted: false, reusable: false, reason: notFoundReason(d.name) };
      }
      if (chose && strict) {
        if (!hint) throw new UnprocessableEntityException(notFoundReason(d.name));
        if (!hint.reusable) throw new UnprocessableEntityException(hint.reason);
      }
      if (hint) hints.set(norm(d.name), hint);
    }
    return { adopt, hints };
  }

  /** #1156 — why the pack's version of `dbName` cannot use the live database `liveId` as it is, in plain language; undefined when it can. */
  private async incompatibility(membership: Membership, manifest: PackManifest, dbName: string, liveId: string): Promise<string | undefined> {
    const detail = await this.databases.get(membership, liveId);
    const fields = ((detail as unknown as { fields: LiveField[] }).fields ?? []).map((f) => ({ displayName: f.displayName, type: f.type, options: f.options }));
    const planned = manifest.databases.find((x) => norm(x.name) === norm(dbName));
    const problems: string[] = [];
    for (const f of planned?.fields ?? []) {
      const decision = decideField(fields, f.name, f.type);
      if (decision.action === 'reuse' && decision.clash) problems.push(typeClash(f.name, decision.clash.live_type, decision.clash.planned_type));
    }
    for (const st of manifest.states.filter((x) => norm(x.database) === norm(dbName))) {
      const decision = decideState(fields, st.field, st.options);
      if (decision.action === 'blocked') problems.push(typeClash(st.field, decision.live_type, 'select'));
    }
    return problems.length > 0 ? `${problems.join('; ')}.` : undefined;
  }

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
  async preview(
    membership: Membership,
    rawManifest: unknown,
    targetSpaceId?: string,
    /** #1107 — see `install`. A preview that ignored it would show the rules off that the install then turns on. */
    enableAutomations: string[] = [],
    /** #1156 — the same `resolutions` install takes: a `reuse` the person chose for a database in another space is shown as adopted. */
    resolutions: PackInstallResolutions = {},
  ): Promise<PackPreviewResult> {
    const manifest = this.parseManifest(rawManifest);
    // #1095 — a preview that ignored the input install takes would promise a different install: same checks, same refusals.
    if (targetSpaceId) await this.resolveTargetSpace(membership, manifest, targetSpaceId);
    const unmet = await this.checkRequirements(membership, manifest);
    const plan = await this.planAdoptions(membership, manifest, targetSpaceId, resolutions, await this.findExistingInstall(membership.workspaceId, manifest.slug), false);
    const { databases, views, automations, agents } = await this.computeCollisions(membership, manifest, targetSpaceId, plan.adopt);
    for (const item of databases) {
      const hint = plan.hints.get(norm(item.name));
      if (hint) item.existing_elsewhere = hint;
    }
    // #1107 — what each rule this install would create would BE: on or off, and why off. A rule that already exists is left alone, so says nothing.
    const turnedOn = this.labelSet(enableAutomations);
    const plannedByLabel = new Map<string, (typeof manifest.automations)[number]>(manifest.automations.map((a) => [`${a.database}.${a.name}`, a]));
    for (const item of automations) {
      const planned = plannedByLabel.get(item.name);
      if (!planned || item.action === 'reuse') continue;
      const state = installedEnabledState(planned.actions, planned.enabled, turnedOn.has(norm(item.name)));
      item.enabled_on_install = state.enabled;
      if (state.switched_off_because) item.switched_off_because = state.switched_off_because;
    }
    return { slug: manifest.slug, name: manifest.name, version: manifest.version, unmet, databases, views, automations, agents };
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
    targetSpaceId?: string,
    adopt?: Map<string, { id: string; name: string }>,
  ): Promise<{
    databases: PackPreviewItem[];
    views: PackPreviewItem[];
    automations: PackPreviewItem[];
    agents: PackPreviewItem[];
    agentPlans: Map<string, AgentUpdatePlan>;
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

    // #1156 — a planned database is matched only among the databases of the space it goes into (see `homeSpaceMatcher`), exactly as
    // `ArchitectService.buildDatabases` does for the install, so this never reports a collision with a database the install would not touch.
    const trackedDbIds = existingInstall ? await this.trackedDatabaseIds(existingInstall.id) : new Map<string, string>();
    const inHomeSpace = await this.architect.homeSpaceMatcher(membership, targetSpaceId ? { id: targetSpaceId } : undefined, trackedDbIds);
    const liveByName = new Map<string, NonNullable<ReturnType<typeof inHomeSpace>>>();
    for (const d of manifest.databases) {
      // #1157 — a database this install tracked (or the person chose to reuse) wins over a same-named one in the home space.
      const found = (adopt?.get(norm(d.name)) as ReturnType<typeof inHomeSpace>) ?? inHomeSpace(d.name, d.space);
      if (found) liveByName.set(norm(d.name), found);
    }

    // #1156 — a live database is `reuse` only if it IS the one this install recorded (same id); a same-named one the install did not create
    // is a `collision` needing the person's explicit choice, however many times the pack was installed elsewhere.
    const databases: PackPreviewItem[] = manifest.databases.map((d) => {
      const found = liveByName.get(norm(d.name));
      return { name: d.name, action: !found ? 'create' : trackedDbIds.get(norm(d.name)) === found.id ? 'reuse' : 'collision' };
    });

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

    // #982 — what a REUSED database gains: decided by the same functions the install runs (agents/plan-decisions.ts).
    const gainsByDb = await this.databaseGains(membership, manifest, liveByName, views);
    for (const item of databases) {
      const gains = item.action === 'create' ? undefined : gainsByDb.get(norm(item.name));
      if (gains) item.gains = gains;
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
    const agentPlans = existingInstall && agentsDb ? await this.planAgentUpdates(membership, manifest, existingInstall.id, agentsDb.id) : new Map<string, AgentUpdatePlan>();
    const agents: PackPreviewItem[] = manifest.agents.map((a) => {
      const action = classify('agent', a.name, agentTitles?.has(norm(a.name)) ?? false);
      const plan = action === 'reuse' ? agentPlans.get(norm(a.name)) : undefined;
      return plan ? { name: a.name, action, agent_update: plan.update } : { name: a.name, action };
    });

    return { databases, views, automations, agents, agentPlans };
  }

  /**
   * The pack-defined content of an agent record in ONE comparable shape (#977): the texts as markdown, the option ids sorted. Both the
   * live record and the manifest go through it — the manifest side after `agentContentValues` turned it into blocks — so "did this
   * agent change" can never be a question about how the editor happens to normalise whitespace or block structure.
   */
  private agentContent(values: Record<string, unknown>, declared: { aiMode?: boolean; skills?: boolean } = {}) {
    const text = (v: unknown) => (Array.isArray(v) ? blocksToMarkdown(v as never).trim() : '');
    const ids = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string').sort() : []);
    return {
      goal: text(values.goal),
      instructions: text(values.instructions),
      scopes: ids(values.scopes),
      approval_policy: ids(values.approval_policy),
      // ticket #1106: part of an agent's pack content ONLY when the pack declares it. Absent keys keep every hash an earlier install
      // recorded valid (so no existing agent flips to "edited"), and a person who set the mode or skills by hand on an agent the pack
      // never configured is not reported as having edited it.
      ...(declared.aiMode ? { ai_mode: typeof values.ai_mode === 'string' ? values.ai_mode : '' } : {}),
      ...(declared.skills ? { skills: typeof values.skills === 'string' ? values.skills.trim() : '' } : {}),
    };
  }

  /**
   * For every agent an earlier install of this pack created and that is still live: would this version change it, and if so may it be
   * applied without asking? (#977) The classification is the whole product rule —
   *   live == pack's new content          -> unchanged (nothing to do)
   *   live == what the pack installed     -> will_update (the person never touched it)
   *   anything else                       -> edited_needs_choice, Keep mine unless the person takes the update
   * An agent with no recorded origin (installed before this was tracked) falls into the last case on purpose: it is never overwritten.
   */
  private async planAgentUpdates(
    membership: Membership,
    manifest: PackManifest,
    packInstallId: string,
    agentsDbId: string,
  ): Promise<Map<string, AgentUpdatePlan>> {
    const plans = new Map<string, AgentUpdatePlan>();
    if (manifest.agents.length === 0) return plans;
    const items = await this.db.query.packInstallItems.findMany({
      where: and(eq(packInstallItems.packInstallId, packInstallId), eq(packInstallItems.kind, 'agent')),
    });
    const byName = new Map(items.map((i) => [norm(i.name), i]));
    const { data } = await this.records.list(agentsDbId, { limit: MAX_SCAN });
    const live = new Map(data.map((r) => [norm(r.title), r]));
    for (const planned of manifest.agents) {
      const item = byName.get(norm(planned.name));
      const record = live.get(norm(planned.name));
      if (!item || !record) continue;
      const values = await this.architect.agentUpdateValues(membership, planned, agentsDbId);
      // ticket #1106 (Otto's ruling): an agent's AI mode is NEVER changed by an update on its own: a declared mode that differs from the live
      // one is a CHOICE the person makes in the update review (the same `update` resolution an edited agent uses), and it is never applied
      // unasked, least of all into StoryOS AI, which starts metering. So the mode is kept OUT of the classification below, which decides only
      // whether the rest of the agent is untouched; the mode is then layered on as `ai_mode_change`.
      const declaredFull = { aiMode: 'ai_mode' in values, skills: 'skills' in values };
      const declared = { aiMode: false, skills: declaredFull.skills };
      const next = this.agentContent(values, declared);
      const now = this.agentContent(record.values as Record<string, unknown>, declared);
      const newHash = this.hashOf(next);
      const nowHash = this.hashOf(now);
      const changed: Array<(typeof AGENT_CONTENT_FIELDS)[number]> = AGENT_CONTENT_FIELDS.filter((f) => f !== 'ai_mode' && JSON.stringify(now[f]) !== JSON.stringify(next[f]));
      let update: PackAgentUpdate;
      // The stored origin hash covers only the keys the PREVIOUS version declared, which we cannot see, so "untouched since the pack installed
      // it" is: the live agent hashes to the origin under SOME key set. Skills the pack newly declares over skills the person already wrote
      // count as touched: never overwritten silently.
      const keySets = [{}, { aiMode: true }, { skills: true }, { aiMode: true, skills: true }];
      const origin = item.sourceHash
        ? keySets.find((k) => this.hashOf(this.agentContent(record.values as Record<string, unknown>, k)) === item.sourceHash)
        : undefined;
      const overwritesOwnSkills =
        declared.skills && !(origin as { skills?: boolean } | undefined)?.skills && now.skills !== '' && now.skills !== undefined && now.skills !== next.skills;
      if (nowHash === newHash) {
        update = { status: 'unchanged', changed_fields: [], installed_version: item.packVersion };
      } else if (origin && !overwritesOwnSkills) {
        update = { status: 'will_update', changed_fields: [...changed], installed_version: item.packVersion };
      } else {
        update = {
          status: 'edited_needs_choice',
          changed_fields: [...changed],
          reason: item.sourceHash ? 'edited' : 'unknown_origin',
          diff: {
            ...(changed.includes('goal') ? { goal: lineDiff(now.goal, next.goal) } : {}),
            ...(changed.includes('instructions') ? { instructions: lineDiff(now.instructions, next.instructions) } : {}),
          },
          installed_version: item.packVersion,
        };
      }
      const baseStatus = update.status;

      // The mode, as a choice with both values stated.
      let withoutModeHash: string | undefined;
      if (declaredFull.aiMode) {
        const modeField = ((await this.databases.get(membership, agentsDbId)).fields as unknown as LiveField[]).find((f) => f.apiName === 'ai_mode');
        const labels = new Map((modeField?.options ?? []).map((o) => [o.id, o.label] as const));
        const liveId = typeof record.values['ai_mode'] === 'string' ? (record.values['ai_mode'] as string) : null;
        if (liveId !== (values['ai_mode'] as string)) {
          const proposed = RUN_CLASS_BY_LABEL[labels.get(values['ai_mode'] as string) ?? ''];
          const current = liveId ? RUN_CLASS_BY_LABEL[labels.get(liveId) ?? ''] ?? null : null;
          if (proposed) {
            withoutModeHash = newHash;
            update = {
              ...update,
              status: 'edited_needs_choice',
              reason: update.reason ?? 'ai_mode',
              changed_fields: [...changed, 'ai_mode'],
              ai_mode_change: { current, proposed },
              installed_version: item.packVersion,
            };
          }
        }
      }
      // Provenance after applying: with the mode when the change was taken or there was none, without it when only the rest was applied.
      const fullHash = this.hashOf(this.agentContent(values, declaredFull));
      plans.set(norm(planned.name), {
        update,
        recordId: record.id,
        values,
        newHash: fullHash,
        newHashWithoutMode: withoutModeHash,
        // True when the ONLY reason this needs a choice is the mode: the rest of the agent is untouched, so Keep still brings it up to date.
        restUntouched: baseStatus !== 'edited_needs_choice',
        previous: { packVersion: item.packVersion, sourceHash: item.sourceHash },
      });
    }
    return plans;
  }

  /**
   * Apply what `planAgentUpdates` decided, and say what provenance each agent should carry afterwards (#977).
   * will_update is applied; edited_needs_choice only when the person took it; unchanged and kept-edited agents are left exactly as
   * they are. A kept agent keeps its PREVIOUS origin so the next update still sees it as edited rather than as "matching the new pack".
   */
  private async updateReusedAgents(
    membership: Membership,
    manifest: PackManifest,
    plans: Map<string, AgentUpdatePlan>,
    take: Set<string>,
    result: PackInstallResult,
  ): Promise<AgentProvenance> {
    const provenance: AgentProvenance = new Map();
    const { agentsDb } = await this.agents.findPackDbs(membership.workspaceId);
    for (const entry of result.agents) {
      if (entry.action === 'skipped' || !entry.id || !agentsDb) continue;
      const key = norm(entry.name);
      const plan = plans.get(key);
      if (entry.action === 'created') {
        const record = await this.records.get(agentsDb.id, entry.id);
        const planned = manifest.agents.find((a) => norm(a.name) === key);
        const declared = { aiMode: Boolean(planned?.ai_mode), skills: (planned?.skills.length ?? 0) > 0 };
        provenance.set(key, { packVersion: manifest.version, sourceHash: this.hashOf(this.agentContent(record.values as Record<string, unknown>, declared)) });
        continue;
      }
      if (!plan) continue; // reused but never tracked (an adopted collision): origin unknown, stays null
      const apply = plan.update.status === 'will_update' || (plan.update.status === 'edited_needs_choice' && take.has(key));
      // ticket #1106: only the AI mode needs the choice and the person kept theirs: bring the rest up to date WITHOUT the mode.
      const keepModeOnly = !apply && plan.update.ai_mode_change !== undefined && plan.restUntouched === true;
      if (apply) {
        await this.records.update(membership.workspaceId, agentsDb.id, plan.recordId, plan.values, membership.userId);
        entry.action = 'updated';
        provenance.set(key, { packVersion: manifest.version, sourceHash: plan.newHash });
      } else if (keepModeOnly) {
        const rest = { ...plan.values };
        delete rest['ai_mode']; // the person kept their mode
        if (plan.update.changed_fields.some((f) => f !== 'ai_mode')) {
          await this.records.update(membership.workspaceId, agentsDb.id, plan.recordId, rest, membership.userId);
          entry.action = 'updated';
        }
        provenance.set(key, { packVersion: manifest.version, sourceHash: plan.newHashWithoutMode ?? plan.newHash });
      } else if (plan.update.status === 'unchanged') {
        provenance.set(key, { packVersion: manifest.version, sourceHash: plan.newHash });
      } else {
        provenance.set(key, plan.previous);
      }
    }
    return provenance;
  }

  /**
   * What the install would ADD to each database that already exists (#982), and what it would leave alone and why.
   *
   * It replays the install's order against live state — fields, relations, states, derived fields, then views — keeping a simulated field
   * list per database, so a field an earlier step creates is seen by a later step exactly as the install would see it. Every decision is
   * `agents/plan-decisions.ts`, the module `ArchitectService` and the install call to decide, so the answer cannot be a second opinion.
   */
  private async databaseGains(
    membership: Membership,
    manifest: PackManifest,
    liveByName: Map<string, { id: string; name: string }>,
    viewItems: PackPreviewItem[],
  ): Promise<Map<string, PackDatabaseGains>> {
    type SimField = { displayName: string; type: string; options?: Array<{ label: string }> };
    const sim = new Map<string, SimField[]>();
    const gains = new Map<string, PackDatabaseGains>();
    for (const d of manifest.databases) {
      const live = liveByName.get(norm(d.name));
      if (!live) continue;
      const detail = await this.databases.get(membership, live.id);
      sim.set(norm(d.name), ((detail as unknown as { fields: LiveField[] }).fields ?? []).map((f) => ({ displayName: f.displayName, type: f.type, options: f.options })));
      gains.set(norm(d.name), { fields: [], options: [], views: [], not_applied: [] });
    }
    const add = (db: string, name: string, type: string, options?: Array<{ label: string }>) => {
      const fields = sim.get(norm(db));
      if (!fields) return;
      fields.push({ displayName: name, type, options });
      gains.get(norm(db))!.fields.push({ name, type });
    };

    for (const d of manifest.databases) {
      const fields = sim.get(norm(d.name));
      if (!fields) continue;
      for (const f of d.fields) {
        const decision = decideField(fields, f.name, f.type);
        if (decision.action === 'create') add(d.name, f.name, f.type, f.options);
        else if (decision.clash) {
          gains.get(norm(d.name))!.not_applied.push({
            kind: 'field',
            name: `${d.name}.${f.name}`,
            reason: `A "${f.name}" field already exists as ${decision.clash.live_type}; the pack wants ${decision.clash.planned_type}, so it is kept as it is.`,
          });
        }
      }
    }

    for (const r of manifest.relations) {
      const from = sim.get(norm(r.from));
      // The relation exists when the "from" database is live and already has that relation field; otherwise it is created, adding a field
      // on each side that is a live database (a side that is itself created has no gains entry to report on).
      if (from && relationExists(from, r.from_field)) continue;
      add(r.from, r.from_field, 'relation');
      if (r.to_field) add(r.to, r.to_field, 'relation');
    }

    for (const st of manifest.states) {
      const fields = sim.get(norm(st.database));
      if (!fields) continue;
      const decision = decideState(fields, st.field, st.options);
      if (decision.action === 'create') add(st.database, st.field, 'select', st.options);
      else if (decision.action === 'blocked') {
        gains.get(norm(st.database))!.not_applied.push({
          kind: 'state',
          name: `${st.database}.${st.field}`,
          reason: `"${st.field}" already exists as ${decision.live_type}, but a workflow state must be a select field: the install would stop here.`,
          blocks_install: true,
        });
      } else if (decision.options_to_add.length > 0) {
        const declared = Object.fromEntries(
          st.options.filter((o) => o.category && decision.options_to_add.includes(o.label)).map((o) => [o.label, o.category!]),
        );
        gains.get(norm(st.database))!.options.push({
          field: st.field,
          labels: decision.options_to_add,
          ...(Object.keys(declared).length > 0 ? { categories: declared } : {}),
        });
        const existing = fields.find((f) => norm(f.displayName) === norm(st.field));
        if (existing) existing.options = [...(existing.options ?? []), ...decision.options_to_add.map((label) => ({ label }))];
      }
    }

    for (const df of manifest.derived_fields) {
      const fields = sim.get(norm(df.database));
      if (!fields) continue;
      if (decideField(fields, df.name, df.type).action === 'create') add(df.database, df.name, df.type);
    }

    // `viewItems` is one item per planned view, in manifest order: read the database off the manifest, never by splitting the
    // "<database>.<view>" label (a database name may contain a dot).
    manifest.views.forEach((planned, i) => {
      if (viewItems[i]?.action !== 'create') return;
      gains.get(norm(planned.database))?.views.push(planned.name);
    });
    return gains;
  }

  private parseManifest(rawManifest: unknown): PackManifest {
    const parsed = packManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `This is not a valid pack manifest: ${describeManifestIssues(rawManifest, parsed.error.issues)}`,
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

  /**
   * #1156 — the database id each planned database name was installed as, per the install's own record. A database is "this pack's own" by
   * THIS id and no other: a same-named database the install did not create is somebody else's, however alike its name.
   */
  private async trackedDatabaseIds(packInstallId: string): Promise<Map<string, string>> {
    const rows = await this.db.query.packInstallItems.findMany({
      where: and(eq(packInstallItems.packInstallId, packInstallId), eq(packInstallItems.kind, 'database')),
    });
    return new Map(rows.map((r) => [norm(r.name), r.entityId] as const));
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
    /** #1095 — an existing space to install INTO instead of creating the manifest's own. */
    targetSpaceId?: string,
    /**
     * #1107 — "Database.Rule name" labels of automations that act outward or run an agent (installed switched OFF) the person chose to
     * switch ON in the review. The only way such a rule installs on: the manifest's own `enabled: true` is ignored for them.
     */
    enableAutomations: string[] = [],
  ): Promise<PackInstallResult> {
    const manifest = this.parseManifest(rawManifest);
    const targetSpace = targetSpaceId ? await this.resolveTargetSpace(membership, manifest, targetSpaceId) : undefined;
    // Fail fast, before anything is built: a manifest whose agent declares a
    // skill it does not bundle is malformed the same way a dangling `$ref`
    // is, and the same rule applies — a broken promise about the manifest's
    // own contents is a 422, not a partial install.
    this.validateAgentSkillNames(manifest);
    const unmet = await this.checkRequirements(membership, manifest);

    const existingInstall = await this.findExistingInstall(membership.workspaceId, manifest.slug);
    const { adopt } = await this.planAdoptions(membership, manifest, targetSpace?.id, resolutions, existingInstall);
    const collisions = await this.computeCollisions(membership, manifest, targetSpace?.id, adopt);
    const { manifest: working, skippedAgents, viewResolutions, automationResolutions, takeAgents } =
      this.applyResolutions(manifest, collisions, resolutions);

    // ── All-or-nothing (ticket #1112) ────────────────────────────────────────
    // Everything from here on creates things, and the services that create them each use the shared pool and take no transaction handle,
    // so ONE database transaction cannot cover the walk. Instead every entity the install creates is recorded (`ledger`, filled in place
    // by `architect.build` and by each step below), and a failure at ANY point removes exactly the entries marked `created`, then
    // reports the step that failed. Nothing the install merely REUSED is touched.
    const needsAgentOs = working.agents.length > 0 || working.triggers.length > 0;
    const agentOsBefore = needsAgentOs ? await this.snapshotAgentOs(membership.workspaceId) : undefined;
    const ledger: InstallLedger = { built: {} as ArchitectBuildProgress };
    let step = 'building the databases, fields, relations, agents and triggers';

    try {
      // ── The reuse: a PackManifest IS an ArchitectPlan ──────────────────────
      // Databases, fields, relations, states, agents and bindings — all of it,
      // through the walk #214 already ships. Nothing about that walk is
      // reimplemented, adapted or wrapped here.
      const built = await this.architect.build(membership, working, { targetSpace, scopeToHomeSpace: true, adopt, trackedIds: existingInstall ? await this.trackedDatabaseIds(existingInstall.id) : undefined, progress: ledger.built });

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
        skipped_sample_field_values: [],
      };
      ledger.result = result;

      const dbIds = new Map(built.databases.map((d) => [norm(d.name), d.id]));

      // Derived fields go in before the ref table the views use is built: a view
      // may size or show a rollup column, so the rollup has to exist first.
      step = 'adding the lookup and rollup fields';
      await this.installDerivedFields(membership, working, dbIds, result);

      const refToId = await this.readInstallRefs(membership, working, dbIds);
      const hashes = new Map<string, string>();
      // Entity ids never worth a `pack_install_items` row — currently just a
      // database's default view (see `installViews`'s doc). `recordInstall`
      // filters these out so `uninstall` never learns about them at all.
      const untracked = new Set<string>();
      step = 'adding the views';
      await this.installViews(membership, working, dbIds, refToId, result, viewResolutions, hashes, untracked);
      step = 'adding the automations';
      await this.installAutomations(
        membership,
        working,
        dbIds,
        refToId,
        result,
        automationResolutions,
        hashes,
        this.labelSet(enableAutomations),
      );
      step = 'adding the sample records';
      await this.installSampleRecords(membership, working, dbIds, refToId, result);
      step = 'adding the skills';
      await this.installSkills(membership, working, result, hashes);

      // #977 — bring reused agents up to this version, BEFORE their content is hashed for uninstall's modified check below. Last among the
      // steps that change anything: it edits agents that already existed, which a rollback cannot give back, so nothing after it may fail.
      step = 'updating the agents that were already installed';
      const agentProvenance = await this.updateReusedAgents(membership, manifest, collisions.agentPlans, takeAgents, result);
      step = 'recording the install';
      await this.hashInstalledAgents(membership, result, hashes);

      await this.recordInstall(membership, manifest, result, existingInstall, hashes, untracked, agentProvenance);

      return result;
    } catch (error) {
      const problems = await this.rollbackInstall(membership, ledger, agentOsBefore);
      throw this.installFailure(manifest, step, error, problems);
    }
  }

  /** Ids that exist BEFORE an install provisions the Agentic OS space, so a failed install removes only what it made. */
  private async snapshotAgentOs(workspaceId: string): Promise<AgentOsSnapshot> {
    const { agentsDb, runsDb, triggersDb } = await this.agents.findPackDbs(workspaceId);
    const spaceRows = await this.db.select({ id: spacesTable.id }).from(spacesTable).where(eq(spacesTable.workspaceId, workspaceId));
    return {
      databaseIds: new Set([agentsDb?.id, runsDb?.id, triggersDb?.id].filter((id): id is string => Boolean(id))),
      spaceIds: new Set(spaceRows.map((r) => r.id)),
    };
  }

  /**
   * The error a failed install raises: the original status (500 for anything unexpected), the step that failed, and a plain statement of
   * what state the workspace was left in — including anything the cleanup itself could not remove, never silently.
   */
  private installFailure(manifest: PackManifest, step: string, error: unknown, problems: string[]): HttpException {
    const cleanup =
      problems.length === 0
        ? 'Nothing was installed.'
        : `The cleanup could not remove everything the install had made (${problems.join('; ')}) — delete those by hand before installing again.`;
    if (error instanceof HttpException) {
      const status = error.getStatus() >= 400 ? error.getStatus() : 500;
      const response = error.getResponse();
      const reason =
        typeof response === 'string'
          ? response
          : (() => {
              const m = (response as { message?: string | string[] }).message;
              return Array.isArray(m) ? m.join('; ') : (m ?? error.message);
            })();
      return new HttpException(`Installing "${manifest.name}" failed at the step "${step}": ${reason} ${cleanup}`, status);
    }
    this.logger.error(`Pack install "${manifest.slug}" failed at "${step}"`, error instanceof Error ? error.stack : String(error));
    return new HttpException(
      `Installing "${manifest.name}" failed at the step "${step}" because of an unexpected error (it has been logged). ${cleanup}`,
      500,
    );
  }

  /**
   * Remove exactly what a failed install CREATED, newest first — hard deletes, because a soft delete would leave the names (and the trash
   * rows) behind and the re-install would collide again. Entries marked `reused` are never touched, and neither is anything the install did
   * not record: the ledger is the whole list. Returns what could NOT be removed (empty on success).
   */
  private async rollbackInstall(
    membership: Membership,
    ledger: InstallLedger,
    agentOsBefore: AgentOsSnapshot | undefined,
  ): Promise<string[]> {
    const problems: string[] = [];
    const attempt = async (what: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Pack install rollback: ${what} failed: ${reason}`);
        problems.push(`${what}: ${reason}`);
      }
    };
    const created = (entries: Array<{ action: string; id: string }> | undefined) =>
      (entries ?? []).filter((e) => e.action === 'created' && e.id).map((e) => e.id);

    const built = ledger.built;
    const result = ledger.result;
    const workspaceId = membership.workspaceId;
    const createdDbIds = created(built.databases);
    // Views, rules and fields inside a database this install created go with the database; only the ones in databases that already existed
    // need removing one by one.
    const inSurvivingDb = <T extends { databaseId: string }>(rows: T[]) => rows.filter((r) => !createdDbIds.includes(r.databaseId));

    // 1. Skills.
    for (const id of created(result?.skills).reverse()) {
      await attempt(`skill ${id}`, () => this.skills.remove(membership, membership.userId, id));
    }

    // 2. Sample records, and their entries in the sample-data registry.
    const sampleIds = created(result?.sample_records);
    if (sampleIds.length > 0) {
      await attempt('sample records', () => this.db.delete(recordsTable).where(inArray(recordsTable.id, sampleIds)));
      await attempt('sample-data registry', () => untrackSampleRecords(this.db, workspaceId, sampleIds));
    }

    // 3. Automations, then views, in databases that already existed.
    const automationIds = created(result?.automations);
    if (automationIds.length > 0) {
      const rows = await this.db
        .select({ id: automationsTable.id, databaseId: automationsTable.databaseId })
        .from(automationsTable)
        .where(inArray(automationsTable.id, automationIds));
      for (const row of inSurvivingDb(rows)) await attempt(`automation ${row.id}`, () => this.automations.remove(row.databaseId, row.id));
    }
    const viewIds = created(result?.views);
    if (viewIds.length > 0) {
      const rows = await this.db
        .select({ id: viewsTable.id, databaseId: viewsTable.databaseId })
        .from(viewsTable)
        .where(inArray(viewsTable.id, viewIds));
      for (const row of inSurvivingDb(rows.filter((r): r is { id: string; databaseId: string } => r.databaseId !== null))) {
        await attempt(`view ${row.id}`, () => this.views.remove(row.databaseId, row.id));
      }
    }

    // 4. Trigger bindings, then agents (and the write gates a created agent was given). The Agents/Triggers databases may be reused ones.
    const triggerIds = created(built.triggers);
    if (triggerIds.length > 0) await attempt('agent triggers', () => this.db.delete(recordsTable).where(inArray(recordsTable.id, triggerIds)));
    const agentIds = created(built.agents);
    if (agentIds.length > 0) {
      await attempt('agent write gates', () =>
        this.db.delete(agentWriteGates).where(and(eq(agentWriteGates.workspaceId, workspaceId), inArray(agentWriteGates.agentId, agentIds))),
      );
      await attempt('agents', () => this.db.delete(recordsTable).where(inArray(recordsTable.id, agentIds)));
    }

    // 5. Fields this install added to databases that already existed — newest first, relations before plain fields (a relation's paired field
    //    goes with it).
    const removeFields = async (ids: string[]) => {
      if (ids.length === 0) return;
      const rows = await this.db.select({ id: fieldsTable.id, databaseId: fieldsTable.databaseId }).from(fieldsTable).where(inArray(fieldsTable.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.databaseId]));
      for (const id of ids) {
        const databaseId = byId.get(id);
        if (!databaseId || createdDbIds.includes(databaseId)) continue; // gone already, or goes with its database
        await attempt(`field ${id}`, () => this.fields.remove(databaseId, id));
      }
    };
    await removeFields(created(result?.derived_fields).reverse());
    await removeFields(created(built.states).reverse());
    for (const id of created(built.relations).reverse()) await attempt(`relation ${id}`, () => this.relations.remove(workspaceId, id));
    await removeFields(created(built.fields).reverse());

    // 6. Options this install added to a field that was already there.
    const addedOptions = built.addedOptions ?? [];
    if (addedOptions.length > 0) {
      await attempt('added options', () =>
        this.db.delete(selectOptions).where(inArray(selectOptions.id, addedOptions.map((o) => o.optionId))),
      );
    }

    // 7. Databases this install created (a hard delete cascades to everything left inside them), then the Agentic OS databases and space IF this
    //    install is what provisioned them, then the spaces it created.
    if (createdDbIds.length > 0) {
      await attempt('databases', () =>
        this.db.delete(databasesTable).where(and(eq(databasesTable.workspaceId, workspaceId), inArray(databasesTable.id, createdDbIds))),
      );
    }
    const doomedSpaces = new Set(created(built.spaces));
    if (agentOsBefore) {
      await attempt('Agentic OS databases', async () => {
        const now = await this.agents.findPackDbs(workspaceId);
        const fresh = [now.agentsDb, now.runsDb, now.triggersDb].filter(
          (d): d is NonNullable<typeof d> => d !== undefined && !agentOsBefore.databaseIds.has(d.id),
        );
        if (fresh.length > 0) await this.db.delete(databasesTable).where(inArray(databasesTable.id, fresh.map((d) => d.id)));
      });
      const rows = await this.db.select({ id: spacesTable.id, name: spacesTable.name }).from(spacesTable).where(eq(spacesTable.workspaceId, workspaceId));
      for (const row of rows) if (!agentOsBefore.spaceIds.has(row.id) && row.name === 'Agentic OS') doomedSpaces.add(row.id);
    }
    for (const id of doomedSpaces) {
      await attempt(`space ${id}`, async () => {
        // Only an EMPTY space goes: if anything else now lives in it, it is not this install's to delete.
        const left = await this.db.select({ id: databasesTable.id }).from(databasesTable).where(eq(databasesTable.spaceId, id)).limit(1);
        if (left.length === 0) await this.db.delete(spacesTable).where(and(eq(spacesTable.workspaceId, workspaceId), eq(spacesTable.id, id)));
      });
    }
    return problems;
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
    takeAgents: Set<string>;
    skippedAgents: string[];
    viewResolutions: Map<string, PackInstallResolutions[string]>;
    automationResolutions: Map<string, PackInstallResolutions[string]>;
  } {
    const unresolved: string[] = [];

    // #977 — `update` is "take the pack's version of an agent the person edited" and nothing else. Refused everywhere it does not
    // mean that, so a mistyped resolution can never silently overwrite (or silently do nothing).
    const takeAgents = new Set<string>();
    for (const [name, resolution] of Object.entries(resolutions)) {
      if (resolution.action !== 'update') continue;
      const agent = collisions.agents.find((a) => a.name === name);
      if (agent?.action !== 'reuse' || agent.agent_update?.status !== 'edited_needs_choice') {
        throw new UnprocessableEntityException(
          `"update" is only valid for an installed agent that needs a choice (edited since the pack installed it, or the pack proposes a different AI mode); "${name}" is not one. ` +
            `Preview shows which agents need that choice.`,
        );
      }
      takeAgents.add(norm(name));
    }

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

    return { manifest: working, skippedAgents, viewResolutions, automationResolutions, takeAgents };
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
    agentProvenance: AgentProvenance = new Map(),
  ): Promise<void> {
    // #1112 — one real transaction: the install row and ALL its item rows land together or not at all, so a failure here can never
    // leave an install that uninstall only half knows about.
    await this.db.transaction(async (tx) => {
      let installId: string;
      if (existingInstall) {
        installId = existingInstall.id;
      } else {
        const [inserted] = await tx
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
        await tx
          .update(packInstalls)
          .set({ name: manifest.name, version: manifest.version, installedBy: membership.userId })
          .where(eq(packInstalls.id, installId));
        await tx.delete(packInstallItems).where(eq(packInstallItems.packInstallId, installId));
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
        packVersion?: string | null;
        sourceHash?: string | null;
      }> = [];
      const add = (kind: Kind, entries: Array<{ name: string; action: string; id: string }>) => {
        for (const entry of entries) {
          if (entry.action === 'skipped' || !entry.id || untracked.has(entry.id)) continue;
          rows.push({
            packInstallId: installId,
            kind,
            name: entry.name,
            entityId: entry.id,
            action: (entry.action === 'updated' ? 'reused' : entry.action) as 'created' | 'reused',
            contentHash: hashes.get(`${kind}:${entry.id}`) ?? null,
            ...(kind === 'agent' ? (agentProvenance.get(norm(entry.name)) ?? { packVersion: null, sourceHash: null }) : {}),
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

      if (rows.length > 0) await tx.insert(packInstallItems).values(rows);
    });
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
    // #1156 — a view or automation belongs to the database THIS install tracked, found by id. Looking it up by name alone takes the first
    // database of that name in the workspace, which with two "Issues" in different spaces is not necessarily the pack's: its views were
    // then skipped as "already gone". Name stays only as the fallback for a database the install never tracked.
    const liveDbIds = new Set((await this.databases.list(membership)).map((d) => d.id));
    const trackedDbByName = new Map(items.filter((i) => i.kind === 'database' && liveDbIds.has(i.entityId)).map((i) => [norm(i.name), i.entityId] as const));
    const dbIdFor = async (name: string) => trackedDbByName.get(norm(name)) ?? (await this.findDbIdByName(membership, name));

    for (const item of items) {
      if (item.kind === 'view') {
        const database = item.name.split('.')[0] ?? item.name;
        const dbId = await dbIdFor(database);
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
        const dbId = await dbIdFor(database);
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

    // #600 — suggested DATA sources, reported the same way (never blocks
    // install). A source already connected anywhere in the workspace (any
    // target database — the suggestion is about the PROVIDER, not this
    // pack's own databases) is not re-suggested.
    if (manifest.suggested_sources.length > 0) {
      const connectedProviders = new Set(
        (
          await this.db.query.sources.findMany({
            where: eq(sources.workspaceId, membership.workspaceId),
            columns: { providerSource: true },
          })
        ).map((s) => s.providerSource),
      );
      for (const suggestion of manifest.suggested_sources) {
        if (connectedProviders.has(suggestion.provider)) continue;
        unmet.push({
          kind: 'source',
          name: suggestion.provider,
          detail: suggestion.note
            ? `This pack works well with ${suggestion.provider} (${suggestion.note}) — not connected in this workspace yet.`
            : `This pack works well with ${suggestion.provider}, which is not connected in this workspace yet.`,
        });
      }
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
      if (decideField(live, planned.name, planned.type).action === 'reuse') {
        result.derived_fields.push({ name: label, action: 'reused', id: existing!.id });
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
      // #1041 — a manifest in the wild may carry a token from before export stripped them: it is never installed.
      const config = stripPublicSharing(deref(planned.config, refToId, `The view "${label}"`) as Record<string, unknown>);
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

  private labelSet(labels: readonly string[]): Set<string> {
    return new Set(labels.map((l) => norm(l)));
  }

  private async installAutomations(
    membership: Membership,
    manifest: PackManifest,
    dbIds: Map<string, string>,
    refToId: Map<string, string>,
    result: PackInstallResult,
    resolutions: Map<string, PackInstallResolutions[string]> = new Map(),
    hashes: Map<string, string> = new Map(),
    turnedOn: Set<string> = new Set(),
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
      // #1107 — decided on the pack's own planned actions (what the rule DOES), never on the manifest's `enabled` alone.
      const state = installedEnabledState(planned.actions, planned.enabled, turnedOn.has(norm(label)));
      const created = await this.automations.create(
        membership.workspaceId,
        dbId,
        {
          name: targetName,
          trigger: trigger as never,
          condition,
          actions: actions as never,
          enabled: state.enabled,
        },
        membership.userId,
      );
      result.automations.push({
        name: label,
        action: 'created',
        id: created.id,
        enabled: state.enabled,
        ...(state.switched_off_because ? { switched_off_because: state.switched_off_because } : {}),
      });
      // The EFFECTIVE flag, so uninstall's modified-since-install check does not call a rule installed off "edited".
      hashes.set(
        `automation:${created.id}`,
        // `condition ?? null`: a live rule without one reads back `null`, and `undefined` would hash differently, so every unconditioned rule read as edited.
        this.hashOf({ name: targetName, trigger, condition: condition ?? null, actions, enabled: state.enabled }),
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
    // #749 — every record THIS install actually creates below gets registered
    // into workspace.settings.sample_record_ids (trackSampleRecords, shared
    // with TemplatesService — one registry, not a second copy of it). A
    // title-matched REUSE further down is deliberately excluded: it is either
    // already tracked from whichever install created it, or a genuine
    // pre-existing user record that happens to share a title — either way it
    // was not seeded by this install, and identity here is the id this
    // install itself produced, never the title match used to decide reuse.
    const createdIds: string[] = [];

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
      /*
       * #568 — a sample record's `$option:`/`$field:` refs are this PACK's own
       * promise about what IT creates. When `planned.database` resolved as
       * `reuse` (an already-installed pack's database, not one this install
       * created), that promise is no longer this install's to keep: the actual
       * live field may genuinely lack an option this pack's own manifest
       * assumed would exist (e.g. Consulting OS's "health" Industry option,
       * absent from Agency OS's already-installed Clients). Deref'ing the
       * WHOLE record at once (the pre-#568 behaviour) meant one such value
       * failed the entire install with a 422 — installing two ordinary packs
       * that happen to share a database name should not be able to do that.
       *
       * So: per-field, not whole-object. A database this pack itself CREATED
       * still gets the old hard-fail — there, every ref really is self-
       * inconsistency in this pack's own manifest, exactly what `deref` exists
       * to catch.
       */
      const dbAction = result.databases.find((d) => norm(d.name) === norm(planned.database))?.action;
      const isReused = dbAction === 'reused';
      const values: Record<string, unknown> = {};
      for (const [field, rawValue] of Object.entries(planned.values)) {
        try {
          // #1015 — `$me`, `$date:±Nd` and `$sample:Db/Title` are decided here, at install (see SAMPLE_ME in @storyos/schemas); anything
          // else is untouched. A `$sample:` that points at nothing drops out of the value instead of failing the install.
          const raw = await this.resolveSampleTokens(rawValue, membership.userId, dbIds, titlesFor);
          if (raw === SAMPLE_UNRESOLVED) {
            result.skipped_sample_field_values.push({ record: label, field, reason: 'a $sample: reference that matches no earlier sample record' });
            continue;
          }
          values[field] = deref(raw, refToId, `A sample record of "${planned.database}"`);
        } catch (err) {
          if (!isReused) throw err;
          result.skipped_sample_field_values.push({
            record: label,
            field,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const created = await this.records.create(
        membership.workspaceId,
        dbId,
        values,
        membership.userId,
        0,
        // #481 — seeded from the pack's own manifest template, not typed by the
        // person installing it.
        'automation',
      );
      known.set(norm(title), created.id);
      result.sample_records.push({ name: label, action: 'created', id: created.id });
      createdIds.push(created.id);
    }
    await trackSampleRecords(this.db, membership.workspaceId, createdIds);
  }

  /**
   * #1015 — sample-record value tokens (documented at `SAMPLE_ME` in `@storyos/schemas`): `$me` is the installer, `$date:±Nd` a date
   * relative to install day, `$sample:<Database>/<Title>` another sample record's id (earlier in the manifest). Walks strings, arrays and
   * objects. A `$sample:` that resolves to nothing is dropped from an array, and a bare one makes the whole field unresolved.
   */
  private async resolveSampleTokens(
    value: unknown,
    userId: string,
    dbIds: Map<string, string>,
    titlesFor: (dbId: string) => Promise<Map<string, string>>,
  ): Promise<unknown> {
    const walk = async (node: unknown): Promise<unknown> => {
      if (typeof node === 'string') {
        if (node === SAMPLE_ME) return userId;
        const date = resolveSampleDate(node);
        if (date) return date;
        const ref = /^\$sample:([^/]+)\/(.+)$/.exec(node);
        if (!ref) return node;
        const dbId = dbIds.get(norm(ref[1]!));
        const id = dbId ? (await titlesFor(dbId)).get(norm(ref[2]!)) : undefined;
        return id ?? SAMPLE_UNRESOLVED;
      }
      if (Array.isArray(node)) {
        const items = await Promise.all(node.map(walk));
        return items.filter((v) => v !== SAMPLE_UNRESOLVED);
      }
      if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) out[k] = await walk(v);
        return out;
      }
      return node;
    };
    return walk(value);
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
