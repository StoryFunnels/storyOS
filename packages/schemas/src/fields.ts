import { z } from 'zod';

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
/** Button actions (MN-046, shared with MN-047 automations). */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_values'),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('create_record'),
    database_id: z.uuid(),
    values: z.record(z.string(), z.unknown()).default({}),
    link_via_relation_field_id: z.uuid().optional(),
  }),
  z.object({
    type: z.literal('add_comment'),
    body_template: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('notify_user'),
    // '@me' or the api_name of a user field on this record
    user: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('update_linked'),
    // a relation field on this database; its linked records get the values
    relation_field_id: z.uuid(),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('send_slack_message'),
    // {Field Name} tokens are interpolated from the triggering record
    text: z.string().min(1).max(3000),
    // channel id/name; falls back to the workspace's default Slack channel
    channel: z.string().min(1).max(200).optional(),
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

/** Rollup (MN-064): aggregate related records; count works with no target field. */
export const rollupConfigSchema = z.object({
  relation_field_id: z.uuid(),
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  target_field_api_name: z.string().trim().min(1).nullish(),
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
]);

export const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: automationTriggerSchema,
  condition: z.unknown().optional(),
  actions: z.array(actionSchema).min(1).max(10),
  enabled: z.boolean().default(true),
});

export const updateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  trigger: automationTriggerSchema.optional(),
  condition: z.unknown().nullable().optional(),
  actions: z.array(actionSchema).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});
