import { z } from 'zod';
import { architectPlanSchema } from './architect';
import { viewTypeSchema } from './views';

/**
 * Business Packs — the pack format (MN-218 / #160).
 *
 * A Business Pack is the full operating system for a vertical: databases and
 * relations, views, workflow states with human gates, automations, agent
 * definitions with their state bindings, and skills. Templates ship only
 * schema + views + sample records; a pack is meant to install a *running*
 * system.
 *
 * ── Why this extends `architectPlanSchema` rather than restating it ──────────
 *
 * `ArchitectPlan` (#213/#214) already describes databases, relations, states,
 * agents and triggers, and `ArchitectService.build` already walks it through the
 * ordinary CRUD services — deterministically, find-by-name, idempotently. That
 * is most of a pack installer, and a second one would rot the moment the two
 * disagreed about what "reuse" means.
 *
 * So a `PackManifest` **is** an `ArchitectPlan`, structurally and by type: the
 * extension is flat, not nested, which means `PacksService.install` can hand the
 * manifest straight to `ArchitectService.build` with no adapter and no copy of
 * the walk. The compiler enforces the "one installer" rule — if the core ever
 * stopped being a valid plan, `build(manifest)` would stop type-checking. What a
 * pack adds on top is only what the Architect has no concept of: views,
 * automations, sample records, derived fields, a version, and its requirements.
 *
 * ── Symbolic refs: the crux ─────────────────────────────────────────────────
 *
 * Nothing in a manifest may carry a real id: the ids do not exist until install.
 * The Architect solves this for its own scope with *names* — a plan says
 * `{database: 'Leads', field: 'Status'}` and build resolves it against live
 * schema. That works because those refs sit in typed, structured slots.
 *
 * The parts a pack adds cannot do that. A view config stores
 * `group_by_field_id: z.uuid()`; automation triggers store `field_id`; a rollup
 * stores `relation_field_id`; `column_widths` is *keyed* by field id. These are
 * opaque blobs with ids buried inside them at arbitrary depth, so a ref has to
 * survive in a slot that expects a string. Hence a **string encoding of the same
 * idea** the Architect already uses:
 *
 *   `$db:leads`                  — the database named "Leads"
 *   `$field:leads.status`        — its field named "Status"
 *   `$option:leads.status.new`   — that select field's "New" option
 *
 * Refs are derived from names by `packSlug`, so they are a deterministic
 * function of the schema rather than an id table anyone has to maintain. Export
 * rewrites ids → refs; install rewrites refs → ids. Both directions walk the
 * blob generically (see `PACK_REF_PATTERN`), which is what keeps this honest as
 * view configs grow new id-shaped keys: a duplicated ref-typed mirror of
 * `viewConfigSchema` would silently drift the first time someone added one.
 */

/** A name-shaped string, as `architect.ts` uses. */
const nameSchema = z.string().min(1).max(200);

/**
 * A JSON blob carried through the manifest verbatim except for ref rewriting.
 *
 * Deliberately not a ref-typed mirror of `viewConfigSchema` / `actionSchema`:
 * those are large, they change, and a copy would drift silently — the failure
 * mode being "views install broken", which is exactly what refs exist to
 * prevent. The manifest validates that this is *a JSON object*; the real
 * validation happens at install, when the deref'd config meets
 * `ViewsService.create` / `AutomationsService.create` — the same validated path
 * a person's HTTP client uses. Same bargain the Architect strikes: shapes are
 * checked here, meaning is checked against live schema.
 */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Matches a symbolic ref anywhere a string is allowed. */
export const PACK_REF_PATTERN = /^\$(db|field|option):[a-z0-9-]+(\.[a-z0-9-]+){0,2}$/;

export const packRefSchema = z.string().regex(PACK_REF_PATTERN, 'not a symbolic pack ref');

/**
 * Name → ref slug. Lowercase, and every run of non-alphanumerics becomes a
 * single dash, so `.` and `:` — the ref separators — cannot appear in a slug and
 * a ref always parses unambiguously.
 *
 * Lossy by construction ("Due date" and "Due-Date" collide). That is fine
 * *because* it is checked: the exporter refuses to emit a manifest whose slugs
 * collide rather than shipping one where two fields quietly share a ref.
 */
export function packSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const dbRef = (db: string) => `$db:${packSlug(db)}`;
export const fieldRef = (db: string, field: string) => `$field:${packSlug(db)}.${packSlug(field)}`;
export const optionRef = (db: string, field: string, option: string) =>
  `$option:${packSlug(db)}.${packSlug(field)}.${packSlug(option)}`;

/**
 * The connections a pack can require.
 *
 * Named after what the workspace actually configures (`workspaces.settings`),
 * because an unmet requirement has to be *actionable*: "connect Slack" points at
 * a real settings page. `email` is the built-in mailer rather than an
 * integration, and is listed because a pack that emails people still depends on
 * it being configured.
 */
export const PACK_CONNECTIONS = ['slack', 'github', 'linear', 'email'] as const;
export const packConnectionSchema = z.enum(PACK_CONNECTIONS);
export type PackConnection = (typeof PACK_CONNECTIONS)[number];

/**
 * What a pack needs from AI, mapped onto ADR-0010's run classes.
 *
 *   none    — deterministic automations only; no model anywhere.
 *   byo     — your own model drives it over MCP. `your_own_ai`: NEVER metered.
 *   storyos — wants StoryOS's managed model. `storyos_ai`: metered.
 *
 * This is a **declaration a human reads before installing**, and nothing else.
 * It deliberately does not reach the runtime: the run class is a property of the
 * runtime that executes and is stamped on the Run record at dispatch
 * (agent-runtime.ts), so a `byo` pack cannot be metered by StoryOS no matter
 * what its manifest claims — classification cannot be talked out of by data.
 * Were this field to *select* a runtime, a malicious or careless manifest would
 * become a billing input, which is precisely the coupling ADR-0010 forbids.
 */
export const PACK_AI_NEEDS = ['none', 'byo', 'storyos'] as const;
export const packAiNeedSchema = z.enum(PACK_AI_NEEDS);
export type PackAiNeed = (typeof PACK_AI_NEEDS)[number];

export const packRequiresSchema = z.object({
  connections: z.array(packConnectionSchema).default([]),
  ai: packAiNeedSchema.default('none'),
});
export type PackRequires = z.infer<typeof packRequiresSchema>;

/**
 * Semver, strictly. `1.0` and `v1.2.3` are rejected: upgrade decisions are made
 * by comparing these, and a version that does not parse is worse than no version
 * at all because it looks like one.
 */
export const packVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/,
    'version must be semver, e.g. "1.0.0"',
  );

/** A saved view, with every id in `config` replaced by a symbolic ref. */
export const packViewSchema = z.object({
  /** The database it belongs to, by name (as the plan refers to databases). */
  database: nameSchema,
  name: z.string().min(1).max(100),
  type: viewTypeSchema,
  config: jsonObjectSchema.default({}),
});
export type PackView = z.infer<typeof packViewSchema>;

/** An automation rule, with refs for `trigger.field_id`, action ids, etc. */
export const packAutomationSchema = z.object({
  database: nameSchema,
  name: z.string().min(1).max(200),
  trigger: jsonObjectSchema,
  condition: z.unknown().optional(),
  actions: z.array(jsonObjectSchema).default([]),
  enabled: z.boolean().default(true),
});
export type PackAutomation = z.infer<typeof packAutomationSchema>;

/**
 * A field whose config *points at another field* — lookup, rollup, button.
 *
 * Separate from `databases[].fields` for a reason that is structural rather than
 * cosmetic: a rollup's `relation_field_id` names a relation field, and relations
 * are built *after* databases. Left in `fields`, such a field would be created
 * while the thing it references still does not exist. So these are declared
 * apart and installed in a post-pass, once the relations they depend on are
 * real. The ordering constraint is the reason the split exists; nothing else is
 * different about them.
 */
export const packDerivedFieldSchema = z.object({
  database: nameSchema,
  name: nameSchema,
  type: z.enum(['lookup', 'rollup', 'button']),
  config: jsonObjectSchema.default({}),
});
export type PackDerivedField = z.infer<typeof packDerivedFieldSchema>;

/** A sample record. `values` is keyed by api_name; option ids appear as refs. */
export const packSampleRecordSchema = z.object({
  database: nameSchema,
  values: jsonObjectSchema.default({}),
});
export type PackSampleRecord = z.infer<typeof packSampleRecordSchema>;

/**
 * The manifest.
 *
 * `format_version` is the *envelope* version and is not the pack's `version`:
 * one says how to read the file, the other says which release of the business
 * process it carries. Conflating them is how a format ends up unable to
 * distinguish "I cannot parse this" from "this is older than what you have".
 */
export const packManifestSchema = architectPlanSchema.extend({
  /**
   * Inherited from `ArchitectPlan`, where it names the scenario template a
   * proposed plan came from. A pack came from an export, not a template, so it
   * defaults rather than asking authors to invent one.
   *
   * Defaulted here instead of made optional upstream on purpose: `scenario` is
   * required of a *proposed* plan, and relaxing it in `architectPlanSchema` to
   * suit packs would have weakened validation for the Architect — a plan of just
   * a summary would have become valid — and loosened the type every existing SDK
   * and UI consumer reads. The looseness belongs to the format that needs it.
   */
  scenario: z.string().min(1).max(100).default('pack'),
  format_version: z.literal(1),
  /** Stable identity across versions — the thing an upgrade matches on. */
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1).max(200),
  version: packVersionSchema,
  /** What changed since the previous version, for the human deciding to upgrade. */
  upgrade_notes: z.string().max(5000).optional(),
  requires: packRequiresSchema.default({ connections: [], ai: 'none' }),

  derived_fields: z.array(packDerivedFieldSchema).default([]),
  views: z.array(packViewSchema).default([]),
  automations: z.array(packAutomationSchema).default([]),
  sample_records: z.array(packSampleRecordSchema).default([]),

  /**
   * Reserved for #40. **Nothing populates or reads this yet.**
   *
   * ADR-0010 describes an agent's `skills` as "a relation, once #40 lands"; no
   * Skills database, service or schema exists in the codebase today. The field
   * is reserved rather than designed because inventing a Skills system here
   * would prejudge #40's model, and reserved rather than omitted because the
   * ACs bind the manifest to cover skills and a later addition must not need a
   * `format_version` bump to do it.
   *
   * TODO(#40): give this an element schema and wire export/install, at which
   * point `PackAgent.skills` becomes a ref list into it.
   */
  skills: z.array(z.unknown()).default([]),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

/** One unmet requirement, as install reports it. */
export const packUnmetRequirementSchema = z.object({
  kind: z.enum(['connection', 'ai']),
  name: z.string(),
  detail: z.string(),
});
export type PackUnmetRequirement = z.infer<typeof packUnmetRequirementSchema>;

const installedEntitySchema = z.object({
  name: z.string(),
  action: z.enum(['created', 'reused']),
  id: z.string(),
});

/**
 * What install did.
 *
 * `unmet` is the interesting part: a pack whose Slack connection is missing
 * still installs. Refusing would leave the operator with nothing, and
 * half-installing silently would leave them with something worse than nothing —
 * so the schema, views and agents all land, and the gap is *reported* for them
 * to close in settings. The pack is inert in exactly the way the missing
 * connection implies, and no more.
 */
export const packInstallResultSchema = z.object({
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  unmet: z.array(packUnmetRequirementSchema),
  spaces: z.array(installedEntitySchema),
  databases: z.array(installedEntitySchema),
  fields: z.array(installedEntitySchema),
  relations: z.array(installedEntitySchema),
  states: z.array(installedEntitySchema),
  agents: z.array(installedEntitySchema),
  triggers: z.array(installedEntitySchema),
  derived_fields: z.array(installedEntitySchema),
  views: z.array(installedEntitySchema),
  automations: z.array(installedEntitySchema),
  sample_records: z.array(installedEntitySchema),
});
export type PackInstallResult = z.infer<typeof packInstallResultSchema>;

/** What to export: a space by name, or an explicit list of database ids. */
export const packExportRequestSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),
    name: z.string().min(1).max(200),
    version: packVersionSchema.default('1.0.0'),
    summary: z.string().min(1).max(2000).default('Exported workspace slice'),
    upgrade_notes: z.string().max(5000).optional(),
    /** The slice: a space name, or explicit database ids. Exactly one. */
    space: z.string().min(1).max(200).optional(),
    database_ids: z.array(z.uuid()).optional(),
    /** Include records as sample data. Off by default — records are data, not schema. */
    include_sample_records: z.boolean().default(false),
    /** Cap on sample records per database. */
    sample_limit: z.number().int().min(1).max(50).default(5),
    /**
     * Override the derived AI need. Connections are always derived from content
     * (a pack that posts to Slack requires Slack whatever its author believes),
     * but whether a workflow wants your model or StoryOS's is a policy choice
     * the content cannot reveal.
     */
    ai: packAiNeedSchema.optional(),
    /**
     * Connections to declare *in addition* to the derived ones.
     *
     * Derivation only sees what the manifest contains, and it cannot see intent:
     * a pack whose agent is meant to file GitHub issues has nothing in its
     * automations that says so. Additive rather than authoritative — an author
     * may add to the derived set but cannot talk the exporter out of a
     * requirement its own content proves.
     */
    connections: z.array(packConnectionSchema).default([]),
  })
  .refine((v) => Boolean(v.space) !== Boolean(v.database_ids?.length), {
    message: 'specify exactly one of `space` or `database_ids`',
  });
export type PackExportRequest = z.infer<typeof packExportRequestSchema>;
