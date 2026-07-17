import { z } from 'zod';
import { creatableFieldTypeSchema, OPTION_COLORS } from './fields';
import { relationCardinalitySchema } from './relations';

/**
 * The Architect's plan (#213 / #214, ADR-0010 §6 —
 * docs/decisions/ADR-0010-agentic-os-engine.md).
 *
 * ADR-0010 §6: "MN-217 is a build-time client: from plain language it proposes a
 * plan (entities, states, agents, gates), and only after approval creates them —
 * reusing existing databases where sensible. Everything it builds is ordinary,
 * hand-editable workspace config. It needs no engine privilege the CRUD API does
 * not already expose."
 *
 * The plan is the whole contract between the two halves. `propose` (#213) emits
 * it and builds NOTHING; `build` (#214) takes it back — after a human has read
 * it — and walks it through the ordinary CRUD services. It lives in the shared
 * schemas package because it is a *reviewable artefact*: the SDK and the web
 * review UI have to render and round-trip it, not just the API.
 *
 * It is deliberately expressed in **names, not ids**. A plan is something a
 * person reads and edits before approving; ids are resolved against live schema
 * at build time, which is also what lets `build` notice that a database the plan
 * meant to reuse has vanished in the meantime (422, not a crash).
 */

const nameSchema = z.string().min(1).max(200);

/** A field the plan wants on a database, in the terms a reviewer reads. */
export const planFieldSchema = z.object({
  name: nameSchema,
  type: creatableFieldTypeSchema,
  /** For select/multi_select fields. Ignored for other types. */
  options: z
    .array(z.object({ label: nameSchema, color: z.enum(OPTION_COLORS).optional() }))
    .optional(),
  /**
   * The field's type config — number precision, `include_time`, `multiline`.
   *
   * Validated per type by `validateFieldConfig` when the field is created, not
   * here, so this stays a passthrough rather than a copy of `fieldConfigSchemas`
   * that would drift from it.
   *
   * Added for Business Packs (MN-218): an export that dropped it would round-trip
   * a currency column back as a plain number. The proposer never sets it, so the
   * Architect is unaffected — it simply stops discarding config it was handed.
   *
   * Fields whose config references *other fields* (lookup, rollup, button) are
   * not expressible here: they must be created after the relations they point
   * at, which is why a pack carries them separately (`derived_fields`).
   */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type PlanField = z.infer<typeof planFieldSchema>;

/**
 * A database the plan touches.
 *
 * `action` is the AC of #213: every entity is marked **create-new vs
 * reuse-existing**. It is not something the proposer decides — it is resolved in
 * `propose` by looking the name up against the workspace's live databases, so a
 * reviewer sees "we will reuse your existing Leads database" rather than
 * discovering a duplicate after the fact.
 */
export const planDatabaseSchema = z.object({
  action: z.enum(['create', 'reuse']),
  name: nameSchema,
  /** The space to create it in. Informational for `reuse`. */
  space: nameSchema,
  /** Non-state fields. State selects are declared under `states`. */
  fields: z.array(planFieldSchema).default([]),
});
export type PlanDatabase = z.infer<typeof planDatabaseSchema>;

/** A relation between two planned/reused databases, by name. */
export const planRelationSchema = z.object({
  /** The "many" side — it carries the single reference. */
  from: nameSchema,
  to: nameSchema,
  cardinality: relationCardinalitySchema,
  /** The field created on `from`, pointing at `to`. */
  from_field: nameSchema,
  /** The field created on `to`, collecting the `from` records. */
  to_field: nameSchema,
});
export type PlanRelation = z.infer<typeof planRelationSchema>;

/**
 * A workflow state field: a select whose options are the states (ADR-0010 §5 —
 * "a state is a select; that is what makes entering a state a discrete,
 * observable transition"). Kept separate from `databases[].fields` because the
 * states are the spine of the workflow a reviewer is approving, not just more
 * columns.
 */
export const planStateSchema = z.object({
  database: nameSchema,
  field: nameSchema,
  options: z.array(z.object({ label: nameSchema, color: z.enum(OPTION_COLORS).optional() })).min(1),
});
export type PlanState = z.infer<typeof planStateSchema>;

/** An agent record the plan wants in the Agents database (ADR-0010 §1). */
export const planAgentSchema = z.object({
  name: nameSchema,
  goal: z.string().min(1).max(2000),
  instructions: z.string().max(5000).optional(),
  /** Subset of read/write/admin — the agent's declared ceiling (ADR-0010 §2). */
  scopes: z.array(z.enum(['read', 'write', 'admin'])).default([]),
  /** Which action classes need a human (ADR-0010 §4). The gates, as data. */
  approval_policy: z
    .array(z.enum(['delete', 'webhook', 'email', 'run_button', 'outward']))
    .default([]),
  /** Names of the databases this agent may act on. */
  target_databases: z.array(nameSchema).default([]),
});
export type PlanAgent = z.infer<typeof planAgentSchema>;

/** A `(database, state, agent)` binding (ADR-0010 §5), by name. */
export const planTriggerSchema = z.object({
  agent: nameSchema,
  database: nameSchema,
  state_field: nameSchema,
  state_option: nameSchema,
  /** A gated state never auto-fires an agent *out* of it — humans only. */
  human_gate: z.boolean().default(false),
});
export type PlanTrigger = z.infer<typeof planTriggerSchema>;

export const architectPlanSchema = z.object({
  /** What this plan does, in one paragraph a human can approve or reject. */
  summary: z.string().min(1).max(2000),
  /** The scenario template the plan came from — see NonAiProposer's honesty note. */
  scenario: z.string().min(1).max(100),
  databases: z.array(planDatabaseSchema).default([]),
  relations: z.array(planRelationSchema).default([]),
  states: z.array(planStateSchema).default([]),
  agents: z.array(planAgentSchema).default([]),
  triggers: z.array(planTriggerSchema).default([]),
});
export type ArchitectPlan = z.infer<typeof architectPlanSchema>;

/**
 * What `build` did — created vs reused, with ids, per entity.
 *
 * `reused` is not a footnote: "reuse, don't duplicate" is an AC, and this is
 * where a caller (or a test) can see which it was.
 */
const builtEntitySchema = z.object({
  name: nameSchema,
  action: z.enum(['created', 'reused']),
  id: z.string(),
});
export type BuiltEntity = z.infer<typeof builtEntitySchema>;

export const architectBuildResultSchema = z.object({
  summary: z.string(),
  scenario: z.string(),
  spaces: z.array(builtEntitySchema),
  databases: z.array(builtEntitySchema),
  fields: z.array(builtEntitySchema),
  relations: z.array(builtEntitySchema),
  states: z.array(builtEntitySchema),
  agents: z.array(builtEntitySchema),
  triggers: z.array(builtEntitySchema),
});
export type ArchitectBuildResult = z.infer<typeof architectBuildResultSchema>;
