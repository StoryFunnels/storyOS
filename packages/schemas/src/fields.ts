import { z } from 'zod';
import { webhookUrlSchema } from './webhooks';
import { filterSchema } from './query';

/** Field types a user can create. title/system/relation types are managed elsewhere. */
export const creatableFieldTypeSchema = z.enum([
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
  'user',
  'lookup',
  'rollup',
  'button',
  'formula',
]);
export type CreatableFieldType = z.infer<typeof creatableFieldTypeSchema>;

export const OPTION_COLORS = [
  'gray',
  'brown',
  'gold',
  'orange',
  'red',
  'pink',
  'purple',
  'blue',
  'teal',
  'green',
] as const;


export const textConfigSchema = z.object({ multiline: z.boolean().default(false) });
export const numberConfigSchema = z.object({
  precision: z.number().int().min(0).max(10).optional(),
  format: z.enum(['plain', 'percent', 'currency']).default('plain'),
  currency_code: z.string().length(3).optional(),
});
export const dateConfigSchema = z.object({ include_time: z.boolean().default(false) });
export const userConfigSchema = z.object({ multi: z.boolean().default(false) });
/**
 * MN-255: any action can be gated behind a human approval instead of running
 * immediately. Spread onto every actionSchema variant below rather than added
 * once at the union level, since z.discriminatedUnion requires each member to
 * be its own z.object with the literal `type` — there's no "base shape" a
 * discriminated union can share. Descriptor-level defaults (e.g. post_social/
 * send_email default to true) are enforced in AutomationActionsService.validate(),
 * not here — the schema only says the flag is legal on every action type.
 */
const gated = { require_approval: z.boolean().optional() };

/** Button actions (MN-046, shared with MN-047 automations). */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    ...gated,
    type: z.literal('set_values'),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...gated,
    type: z.literal('create_record'),
    database_id: z.uuid(),
    values: z.record(z.string(), z.unknown()).default({}),
    link_via_relation_field_id: z.uuid().optional(),
  }),
  z.object({
    ...gated,
    type: z.literal('add_comment'),
    body_template: z.string().min(1).max(2000),
  }),
  z.object({
    ...gated,
    type: z.literal('notify_user'),
    // '@me' or the api_name of a user field on this record
    user: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
  }),
  z.object({
    ...gated,
    type: z.literal('update_linked'),
    // a relation field on this database; its linked records get the values
    relation_field_id: z.uuid(),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...gated,
    type: z.literal('send_slack_message'),
    // {Field Name} tokens are interpolated from the triggering record
    text: z.string().min(1).max(3000),
    // channel id/name; falls back to the workspace's default Slack channel
    channel: z.string().min(1).max(200).optional(),
  }),
  /**
   * MN-088: a one-click manual trigger — the counterpart to MN-032's automatic
   * record-change webhooks. Shares that sender, signing secret and retry path.
   */
  z.object({
    ...gated,
    type: z.literal('send_webhook'),
    url: webhookUrlSchema,
    // {Field Name} tokens are interpolated; omit for the standard record payload
    body_template: z.string().max(10_000).optional(),
    // A header value is a string on write; secret header values are write-only, so
    // reads return the presence flag `{ __keep: true }` in their place and a write
    // may echo it back to keep the stored credential unchanged (#249).
    headers: z
      .record(
        z.string().max(100),
        z.union([z.string().max(1000), z.object({ __keep: z.literal(true) }).strict()]),
      )
      .optional(),
  }),
  /**
   * MN-109 Phase A: run an AI agent (the Agentic OS's Agents database, #209)
   * from a regular automation rule or button — schedule / record event /
   * button, as opposed to the Architect's state-transition bindings (#211).
   * Durable-queued like any other long-running action kind (MN-253) — see
   * job-runner.service.ts's registered 'run_agent' executor, which calls the
   * SAME AgentsService.dispatchRun() every other trigger uses.
   *
   * MN-255 landed (#152): `...gated`'s `require_approval` flag below gates
   * whether the run LAUNCHES. That is independent of an agent's own
   * "Approval policy" (agent-runtime.ts's APPROVAL_POLICY_KINDS), which gates
   * what a launched run's steps may do once it's running.
   */
  z.object({
    ...gated,
    type: z.literal('run_agent'),
    /** Agent record's uuid or public number — resolved the same way manual runs are. */
    agent: z.string().min(1).max(100),
    /**
     * Optional override for the agent's own Goal, for this run only. Phase A
     * keeps this a static string (no {Field} interpolation yet) — becomes the
     * runtime's `AgentRunAgent.goal` for a real driver to read.
     */
    prompt: z.string().max(2000).optional(),
    /**
     * Further caps the agent's own declared Scopes for this run only — can
     * only narrow, never widen (ADR-0010 §2's least-privilege guarantee).
     */
    tool_scope: z.array(z.enum(['read', 'write', 'admin'])).max(3).optional(),
    /**
     * Phase A supports exactly one target: the record that fired this rule or
     * button. There is no other addressable target yet — databases aren't
     * records (#206) — so this is a placeholder for Phase B/C's richer picker.
     */
    target: z.literal('trigger_record').optional(),
    /**
     * Reserved for BYO/managed model selection (Phase D). Inert today — no
     * AgentRuntime driver reads it (pickRuntime() always returns NonAiRuntime)
     * — accepted now so a run_agent action authored against this shape doesn't
     * need a breaking schema change once a real driver exists.
     */
    model: z.string().max(100).optional(),
    /** Guardrail: stop and fail the run rather than let it run unbounded. */
    max_steps: z.number().int().min(1).max(50).optional(),
    /** Guardrail: refuse to execute if the run's classified cost would exceed
     * this many cents. Only meaningful for a 'storyos_ai'-classified run. */
    max_cost_cents: z.number().int().min(0).optional(),
    /** Guardrail: never apply a proposed action for real — log what would
     * happen instead (mirrors fields.service.ts's changeType dry-run shape). */
    dry_run: z.boolean().optional(),
  }),
  /**
   * MN-256: a templated 1:1 email through a workspace Resend/SMTP connection
   * (connections/providers, #231). Durable-queued like every other external
   * kind (MN-253) — job-runner.service.ts's registered 'send_email' executor
   * does the actual send. `to`/`cc`/`reply_to`/`subject`/`body_markdown` are
   * templates — {Field Name}/{payload.…} tokens are interpolated the same way
   * every other action's text does, rendered once before the job is enqueued
   * (or before an approval snapshot freezes, when gated) so the executor
   * itself never touches interpolation.
   *
   * `...gated`'s `require_approval` defaults to true here specifically (see
   * AutomationActionsService.validate()/execute()) UNLESS every rendered
   * recipient resolves to a workspace member's email at run time — an
   * explicit `false` (admin-only, see validate()) always skips the gate.
   */
  z.object({
    ...gated,
    type: z.literal('send_email'),
    /** A `resend`/`smtp` connection (connections/providers) — its own
     * verified from-address is what the mail actually sends as; there is no
     * user-suppliable `from` here (ADR: never spoof storyos.dev). */
    connection_id: z.uuid(),
    /** Comma-separated addresses; each interpolated then validated at send. */
    to: z.string().min(1).max(500),
    cc: z.string().max(500).optional(),
    reply_to: z.string().max(200).optional(),
    subject: z.string().min(1).max(200),
    body_markdown: z.string().min(1).max(10_000),
  }),
  /**
   * MN-263 — call any API from a rule and (optionally) capture the response
   * back onto the record. Durable-queued like run_agent (job-runner.service.ts's
   * registered 'http_request' executor) — never runs inline, so a slow or
   * flaky endpoint retries with backoff instead of stalling the triggering
   * write. url/headers/body_template are {Field}-templated the same way
   * send_webhook's are; `connection_id` (optional) supplies auth merged into
   * the request at SEND TIME ONLY — never stored in this rendered config, see
   * http-request-action.service.ts. `capture` reads named json-paths out of a
   * 2xx JSON response and set_values()s them onto the target fields.
   */
  z.object({
    ...gated,
    type: z.literal('http_request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    // Not webhookUrlSchema: a template like "https://api.example.com/{payload.id}"
    // isn't a valid absolute URL until rendered, so host validation happens at
    // send time (net-guard.ts's assertPublicHost), not save time here.
    url: z.string().min(1).max(2000),
    headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
    body_template: z.string().max(10_000).optional(),
    connection_id: z.uuid().optional(),
    capture: z
      .array(
        z.object({
          /** A common/json-path.ts dot/array path into the parsed JSON response;
           * a leading "$." is stripped for familiarity with jq/JSONPath syntax. */
          path: z.string().max(200),
          target_field_id: z.uuid(),
        }),
      )
      .max(10)
      .optional(),
  }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const buttonConfigSchema = z.object({
  color: z.enum(OPTION_COLORS).optional(),
  confirm: z.string().max(200).optional(),
  actions: z.array(actionSchema).min(1).max(10),
});

/** Lookup (MN-040): surface a related record's field through one of this database's relations. */
export const lookupConfigSchema = z.object({
  relation_field_id: z.uuid(),
  target_field_api_name: z.string().trim().min(1),
});
/** Formula (MN-043): source is user input; ast + result_type are compiled at save. */
export const formulaConfigSchema = z.object({
  expression: z.string().trim().min(1).max(2000),
  ast: z.unknown().optional(),
  result_type: z.enum(['text', 'number', 'checkbox', 'date']).optional(),
});

/**
 * Rollup (MN-064): aggregate related records; count works with no target field.
 * MN-295: an optional filter scopes the aggregate to only the linked records
 * matching a condition (e.g. "count of Issues where State != Done"). Reuses
 * the SAME filter AST as saved views / POST /records/query (`filterSchema`,
 * packages/schemas/src/query.ts) rather than a parallel condition language —
 * it's compiled against the RELATED database's fields, evaluated in
 * apps/api/src/records/records.service.ts's attachRollups()/
 * computeRollupValuesForChunk() via query-compiler's compileFilter(). Omitted
 * (undefined) preserves the pre-MN-295 unconditional-aggregate behavior.
 */
export const rollupConfigSchema = z.object({
  relation_field_id: z.uuid(),
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  target_field_api_name: z.string().trim().min(1).nullish(),
  filter: filterSchema.optional(),
});

export const emptyConfigSchema = z.object({});

export const fieldConfigSchemas: Record<CreatableFieldType, z.ZodType> = {
  text: textConfigSchema,
  rich_text: emptyConfigSchema,
  number: numberConfigSchema,
  checkbox: emptyConfigSchema,
  date: dateConfigSchema,
  select: emptyConfigSchema,
  multi_select: emptyConfigSchema,
  url: emptyConfigSchema,
  email: emptyConfigSchema,
  color: emptyConfigSchema,
  user: userConfigSchema,
  lookup: lookupConfigSchema,
  rollup: rollupConfigSchema,
  button: buttonConfigSchema,
  formula: formulaConfigSchema,
};

export function validateFieldConfig(type: CreatableFieldType, config: unknown) {
  return fieldConfigSchemas[type].safeParse(config ?? {});
}

export const createFieldSchema = z
  .object({
    display_name: z.string().trim().min(1).max(100),
    type: creatableFieldTypeSchema,
    config: z.record(z.string(), z.unknown()).optional(),
    /** Initial options for select/multi_select fields. */
    options: z
      .array(z.object({ label: z.string().trim().min(1).max(100), color: z.string().optional() }))
      .optional(),
  })
  .superRefine((value, ctx) => {
    const result = validateFieldConfig(value.type, value.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: ['config', ...issue.path] });
      }
    }
  });

export const updateFieldSchema = z.object({
  display_name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.number().int().optional(),
});

/** Allowed type conversions (docs/architecture/record-storage.md). */
export const changeFieldTypeSchema = z.object({
  type: creatableFieldTypeSchema,
  dry_run: z.boolean().default(false),
});


export const createOptionSchema = z.object({
  label: z.string().trim().min(1).max(100),
  color: z.enum(OPTION_COLORS).default('gray'),
});

export const updateOptionSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  color: z.enum(OPTION_COLORS).optional(),
  position: z.number().int().optional(),
});

export const deleteOptionSchema = z.object({
  /** Required when records still use the option. */
  confirm: z.boolean().default(false),
  reassign_to: z.uuid().optional(),
});

/** MN-047: automation rules — trigger + optional condition + shared actions. */
export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record_created') }),
  z.object({ type: z.literal('record_updated'), field_id: z.uuid().optional() }),
  z.object({ type: z.literal('record_linked'), relation_field_id: z.uuid() }),
  z.object({
    type: z.literal('schedule'),
    every: z.enum(['hour', 'day', 'week']),
    at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
  }),
  /**
   * MN-254: an inbound URL the outside world can POST to. No config lives on
   * the trigger itself — the endpoint identity (token + secret) lives on the
   * automation row, minted on create/regenerate, because it must survive
   * independently of whatever the trigger object looks like.
   */
  z.object({ type: z.literal('webhook_received') }),
]);

export const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: automationTriggerSchema,
  condition: z.unknown().optional(),
  actions: z.array(actionSchema).min(1).max(10),
  enabled: z.boolean().default(true),
  /** MN-255: who approves a `require_approval` action this rule fires — a
   * user id, defaulting to the rule's own creator (the "rule owner") when
   * omitted. */
  approverId: z.string().optional(),
});

export const updateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  trigger: automationTriggerSchema.optional(),
  condition: z.unknown().nullable().optional(),
  actions: z.array(actionSchema).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  /** MN-255: nullable so a rule can revert to defaulting the rule owner. */
  approverId: z.string().nullable().optional(),
});
