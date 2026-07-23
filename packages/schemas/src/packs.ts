import { z } from 'zod';
import { architectPlanSchema, planAgentSchema } from './architect';
import { skillExampleSchema } from './skills';
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

/**
 * Compares two `packVersionSchema`-shaped strings, ignoring build metadata
 * (`+…`) per semver's own rule that it carries no precedence. Pre-release
 * (`-…`) is compared as a plain string suffix rather than the full semver
 * pre-release algorithm — good enough for "is this a newer release", which is
 * the only question the marketplace ever asks it (MN-220).
 *
 * Returns -1/0/1, the `Array.sort` convention, so `a` newer than `b` is `> 0`.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.split('+')[0]!.split('-', 2);
    return { parts: core!.split('.').map(Number), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // No pre-release outranks any pre-release (semver §11.3): "1.0.0" > "1.0.0-rc.1".
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

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
 * A skill (#40), bundled into a pack.
 *
 * Deliberately the same shape `createSkillSchema` accepts — not a subset, not
 * a wrapper — because #40's whole design point is that a skill is *portable
 * prose*: no record ids, no field ids, nothing StoryOS-internal. That is
 * exactly what a pack needs to carry one, so there is no ref-rewriting here at
 * all (contrast `packViewSchema`/`packAutomationSchema`, which exist because
 * their configs bury real ids). `examples` is imported from `./skills` rather
 * than duplicated for the same reason the rest of that module gives: it is
 * the source of truth, and copying it here is how the two would silently
 * drift the day it grows a field.
 */
export const packSkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  when_to_use: z.string().min(1).max(1000),
  instructions: z.string().min(1).max(20_000),
  examples: z.array(skillExampleSchema).max(20).default([]),
  allowed_tools: z.array(z.string().min(1).max(100)).max(50).default([]),
});
export type PackSkill = z.infer<typeof packSkillSchema>;

/**
 * An agent definition, extended with the skill names (matched against this
 * manifest's `skills[].name`) it is meant to use.
 *
 * This is the ref list `packManifestSchema`'s old TODO(#40) promised, now that
 * #40 exists — and it is an ordinary name list, not a `$ref`-pattern string,
 * for the same reason `target_databases` is: it sits in a typed, structured
 * slot (an array on a known shape), and `$ref` strings exist only for the
 * opaque blobs (`packViewSchema.config`, `packAutomationSchema.trigger`/
 * `actions`) that bury ids at arbitrary, unknowable depth.
 *
 * There is no live agent↔skill relation in the product yet (an Agent record
 * has no `skills` column — see `skills.ts`'s header on why a skill is a plain
 * table, not a provisioned "pack" database), so this is honestly declarative
 * today: `PacksService.install` validates every name resolves to a bundled
 * skill, but nothing yet reads it at runtime. That is the same bargain the
 * rest of the format strikes elsewhere (`requires.ai` is a human-facing
 * declaration, not a runtime input) rather than a gap unique to this field.
 */
export const packAgentSchema = planAgentSchema.extend({
  skills: z.array(nameSchema).default([]),
});
export type PackAgent = z.infer<typeof packAgentSchema>;

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

  /**
   * License/attribution (MN-220). Free text rather than an SPDX-id enum: a
   * pack is a business process, not source code, and "License: internal use
   * only, contact the author to redistribute" is exactly as valid a license
   * as "MIT" — the marketplace displays it verbatim rather than validating
   * against a license list built for software.
   */
  license: z.string().min(1).max(100).default('All rights reserved'),
  /** Who to credit — a person or org name, shown on the listing. */
  attribution: z.string().max(200).optional(),

  /**
   * Overrides `ArchitectPlan.agents`'s element type: a pack agent carries the
   * `skills` name list `planAgentSchema` itself has no reason to know about
   * (the Architect proposer/build walk predates #40 and has no use for it).
   */
  agents: z.array(packAgentSchema).default([]),

  derived_fields: z.array(packDerivedFieldSchema).default([]),
  views: z.array(packViewSchema).default([]),
  automations: z.array(packAutomationSchema).default([]),
  sample_records: z.array(packSampleRecordSchema).default([]),
  /** Skills (#40) bundled into this pack, installed/matched by name. */
  skills: z.array(packSkillSchema).default([]),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

/** One unmet requirement, as install reports it. */
export const packUnmetRequirementSchema = z.object({
  kind: z.enum(['connection', 'ai']),
  name: z.string(),
  detail: z.string(),
});
export type PackUnmetRequirement = z.infer<typeof packUnmetRequirementSchema>;

/**
 * `skipped` (MN-219 / #161) marks an item a collision resolution chose not to
 * install — `id` is `''` in that case, since nothing was created. Only ever
 * produced for agents, views and automations (the categories `preview`
 * reviews and a collision resolution can target — see
 * `packInstallResolutionSchema`'s doc).
 */
const installedEntitySchema = z.object({
  name: z.string(),
  action: z.enum(['created', 'reused', 'skipped']),
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
  skills: z.array(installedEntitySchema),
});
export type PackInstallResult = z.infer<typeof packInstallResultSchema>;

/**
 * One planned item's install fate, as `preview` reports it.
 *
 * `create`/`reuse` are the vocabulary `install` itself uses (see
 * `installedEntitySchema`). `collision` is #161's addition: a live object
 * already has this name, but — unlike `reuse` — it was *not* left behind by an
 * earlier install of this same pack (tracked in `pack_installs`/
 * `pack_install_items`), so installing would silently adopt something the
 * user made or that a different pack owns. Distinguishing the two needs that
 * provenance table; without it every same-name match would have to be treated
 * as either always-safe or always-a-collision, and both are wrong half the
 * time.
 */
export const packPreviewItemSchema = z.object({
  name: z.string(),
  action: z.enum(['create', 'reuse', 'collision']),
});
export type PackPreviewItem = z.infer<typeof packPreviewItemSchema>;

/**
 * What `install` would do, without doing it (MN-219 / #161).
 *
 * Scoped to the four categories a person actually reviews before clicking
 * install — databases, views, automations, agents — not the full
 * `PackInstallResult` breakdown (fields/relations/states/derived_fields/
 * sample_records ride along with their database and aren't independently
 * interesting at preview time). Skills are bundled (#40/#160) but likewise not
 * broken out here — same reasoning as fields: a skill installs alongside the
 * agent that uses it and is not, on its own, something a person reviews
 * before clicking install.
 */
export const packPreviewResultSchema = z.object({
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  unmet: z.array(packUnmetRequirementSchema),
  databases: z.array(packPreviewItemSchema),
  views: z.array(packPreviewItemSchema),
  automations: z.array(packPreviewItemSchema),
  agents: z.array(packPreviewItemSchema),
});
export type PackPreviewResult = z.infer<typeof packPreviewResultSchema>;

/**
 * How to resolve one `collision` reported by `preview` (MN-219 / #161).
 *
 * Keyed in the install request by the same `name` label `preview` used for
 * that item (e.g. a database's name, or `"<database>.<view name>"`) — the
 * label a person already saw on the review screen, so the client does not
 * need a second id scheme just to say "this one, rename it".
 *
 *   reuse  — adopt the existing object as this pack's own from now on
 *            (subsequent re-installs and uninstall track it).
 *   rename — install the pack's version under a different name, leaving the
 *            colliding object untouched.
 *   skip   — do not install this item at all.
 *
 * Only meaningful for the categories `preview` reviews (databases, views,
 * automations, agents) — see `packPreviewResultSchema`'s doc for why the rest
 * ride along uninspected.
 */
export const packInstallResolutionSchema = z
  .object({
    action: z.enum(['reuse', 'rename', 'skip']),
    rename_to: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.action !== 'rename' || Boolean(v.rename_to), {
    message: '`rename` requires `rename_to`',
  });
export type PackInstallResolution = z.infer<typeof packInstallResolutionSchema>;

export const packInstallResolutionsSchema = z.record(z.string(), packInstallResolutionSchema);
export type PackInstallResolutions = z.infer<typeof packInstallResolutionsSchema>;

/**
 * One tracked install of a pack into a workspace, as the "installed" list
 * reports it.
 *
 * `latest_version`/`update_available` are MN-220's addition: looked up by
 * `slug` against whichever catalog the pack came from (the built-in
 * `PACK_REGISTRY` or a published community pack), never against anything
 * stored on the install row itself — a pack that has since been unpublished
 * or renamed simply reports no update, rather than a stale one.
 */
export const packInstallSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  installed_at: z.string(),
  installed_by: z.string(),
  latest_version: z.string().nullable(),
  update_available: z.boolean(),
});
export type PackInstallSummary = z.infer<typeof packInstallSummarySchema>;

/** One object uninstall touched, or chose not to. */
export const packUninstallItemSchema = z.object({
  kind: z.enum(['view', 'automation', 'agent', 'skill']),
  name: z.string(),
  id: z.uuid(),
  /** Present only on `kept` — why it was left behind. */
  reason: z.string().optional(),
});
export type PackUninstallItem = z.infer<typeof packUninstallItemSchema>;

/**
 * What uninstall did (MN-219 / #161).
 *
 * Scoped to views, automations, agents and skills: the objects `install`
 * creates that are independently deletable without collateral damage. Schema
 * (databases/fields/relations/states) and sample records are conservatively
 * never removed by uninstall — deleting a database cascades to every field,
 * relation and record hanging off it, including anything the user built on
 * top since, and no per-field/per-record "modified since install" signal
 * exists to gate that safely. Uninstall leaves schema in place and only ever
 * removes or keeps-with-a-reason the four kinds it tracks a content snapshot
 * for.
 */
export const packUninstallResultSchema = z.object({
  removed: z.array(packUninstallItemSchema),
  kept: z.array(packUninstallItemSchema),
});
export type PackUninstallResult = z.infer<typeof packUninstallResultSchema>;

/** A pack offered in the built-in gallery, manifest included (MN-219 / #161). */
export const packRegistryEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  manifest: packManifestSchema,
});
export type PackRegistryEntry = z.infer<typeof packRegistryEntrySchema>;

/**
 * A public, pre-signup preview of a registry pack (#272).
 *
 * Deliberately not the manifest: a manifest is an install *recipe* (view
 * configs, automation trigger/action blobs, agent instructions) meant for the
 * authenticated install path, not a marketing surface. `contents` is the
 * shallow, human-readable shape of that same recipe — names only, grouped by
 * kind — enough for someone who has never logged in to see what they'd get
 * without exposing anything workspace-specific (there is none; the registry
 * is static, built-in metadata to begin with).
 */
export const packPublicPreviewSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  requires: packRequiresSchema,
  contents: z.object({
    databases: z.array(z.string()),
    views: z.array(z.string()),
    automations: z.array(z.string()),
    agents: z.array(z.string()),
    skills: z.array(z.string()),
  }),
});
export type PackPublicPreview = z.infer<typeof packPublicPreviewSchema>;

/**
 * Community Marketplace (MN-220).
 *
 * ── v1 is curated, not open ──────────────────────────────────────────────────
 *
 * Anyone with a manifest may *submit* it, but nothing a submission does is
 * live until a platform admin approves it — there is no self-serve
 * auto-publish path in this format or its endpoints. `PackSubmission` is the
 * review queue; `published_packs`/`published_pack_versions` (schema.ts) are
 * what approval writes to, and are the only tables the marketplace listing
 * endpoints read from.
 *
 * The vertical is a closed enum rather than free text: it is the one facet
 * the in-app browse view filters/groups by, and a typo'd vertical ("Sals")
 * would silently orphan a listing from its category forever.
 */
export const PACK_LISTING_VERTICALS = [
  'sales',
  'marketing',
  'support',
  'engineering',
  'hr',
  'finance',
  'agency',
  'ops',
  'other',
] as const;
export const packListingVerticalSchema = z.enum(PACK_LISTING_VERTICALS);
export type PackListingVertical = z.infer<typeof packListingVerticalSchema>;

export const packSubmissionStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type PackSubmissionStatus = z.infer<typeof packSubmissionStatusSchema>;

/**
 * The listing metadata a submission adds on top of the manifest itself
 * (which already carries name/summary/version/license/attribution/requires —
 * see `packManifestSchema`'s doc). Required connections are deliberately NOT
 * repeated here: `manifest.requires.connections` is already derived from the
 * pack's real content (`PacksService.deriveConnections`), and a second,
 * author-typed copy in the listing form would just be a second place for it
 * to disagree with the pack.
 */
export const packListingMetaSchema = z.object({
  vertical: packListingVerticalSchema,
  screenshots: z.array(z.url()).max(8).default([]),
});
export type PackListingMeta = z.infer<typeof packListingMetaSchema>;

/** `POST .../packs/submissions` — the manifest is `unknown`, validated at the service boundary like install/preview. */
export const submitPackRequestSchema = packListingMetaSchema.extend({
  manifest: z.unknown(),
});
export type SubmitPackRequest = z.infer<typeof submitPackRequestSchema>;

/** One submission, as an author or a reviewer sees it. */
export const packSubmissionSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  license: z.string(),
  attribution: z.string().optional(),
  vertical: packListingVerticalSchema,
  screenshots: z.array(z.string()),
  requires: packRequiresSchema,
  status: packSubmissionStatusSchema,
  review_notes: z.string().optional(),
  submitted_by: z.string(),
  submitted_at: z.string(),
  reviewed_by: z.string().optional(),
  reviewed_at: z.string().optional(),
});
export type PackSubmission = z.infer<typeof packSubmissionSchema>;

/** `POST /admin/packs/submissions/:id/review` — the one mutation moderation has. */
export const packSubmissionReviewRequestSchema = z.object({
  action: z.enum(['approve', 'reject']),
  notes: z.string().max(2000).optional(),
});
export type PackSubmissionReviewRequest = z.infer<typeof packSubmissionReviewRequestSchema>;

/** One published version, as the listing's changelog shows it. */
export const publishedPackVersionSchema = z.object({
  version: z.string(),
  changelog: z.string().optional(),
  published_at: z.string(),
});
export type PublishedPackVersion = z.infer<typeof publishedPackVersionSchema>;

/** A card in the marketplace browse view — no manifest, same shape discipline as `PackPublicPreview`. */
export const publishedPackCardSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  vertical: packListingVerticalSchema,
  license: z.string(),
  attribution: z.string().optional(),
  screenshots: z.array(z.string()),
  latest_version: z.string(),
  requires: packRequiresSchema,
  published_at: z.string(),
  updated_at: z.string(),
});
export type PublishedPackCard = z.infer<typeof publishedPackCardSchema>;

/** One published pack, manifest (of the latest version) and full changelog included — the install source. */
export const publishedPackDetailSchema = publishedPackCardSchema.extend({
  manifest: packManifestSchema,
  versions: z.array(publishedPackVersionSchema),
});
export type PublishedPackDetail = z.infer<typeof publishedPackDetailSchema>;

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
    /** MN-220 — carried straight onto the manifest; see its own doc there. */
    license: z.string().min(1).max(100).default('All rights reserved'),
    attribution: z.string().max(200).optional(),
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
    /**
     * Skills to bundle, by id. Explicit rather than derived from the slice:
     * a skill (#40) is workspace-wide, not scoped to a space or a list of
     * database ids the way schema is, so there is no "the skills in this
     * slice" to infer — the author picks, the same opt-in shape
     * `include_sample_records` already uses for content that isn't schema.
     */
    skill_ids: z.array(z.uuid()).default([]),
  })
  .refine((v) => Boolean(v.space) !== Boolean(v.database_ids?.length), {
    message: 'specify exactly one of `space` or `database_ids`',
  });
export type PackExportRequest = z.infer<typeof packExportRequestSchema>;
