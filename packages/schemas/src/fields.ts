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
  'user',
  'lookup',
]);
export type CreatableFieldType = z.infer<typeof creatableFieldTypeSchema>;

export const textConfigSchema = z.object({ multiline: z.boolean().default(false) });
export const numberConfigSchema = z.object({
  precision: z.number().int().min(0).max(10).optional(),
  format: z.enum(['plain', 'percent', 'currency']).default('plain'),
  currency_code: z.string().length(3).optional(),
});
export const dateConfigSchema = z.object({ include_time: z.boolean().default(false) });
export const userConfigSchema = z.object({ multi: z.boolean().default(false) });
/** Lookup (MN-040): surface a related record's field through one of this database's relations. */
export const lookupConfigSchema = z.object({
  relation_field_id: z.uuid(),
  target_field_api_name: z.string().trim().min(1),
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
  user: userConfigSchema,
  lookup: lookupConfigSchema,
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
