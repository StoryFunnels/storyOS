import { z } from 'zod';

/**
 * ticket #1218 - record templates: a named starting point for a new record in one database (Linear's issue templates).
 *
 * `values` is keyed by field api_name, exactly like a record's own `values`. It may carry two tokens that are decided when a record is
 * made from the template, not when the template is saved: `$me` (the person creating the record) and `$date:+Nd` / `$date:-Nd`
 * (a date relative to that day). `body` is the record's description document as Markdown, so a template can carry sections
 * ("## Steps to reproduce"). Both are optional: a template that is only a name and a body is valid.
 */
export const recordTemplateNameSchema = z.string().trim().min(1).max(120);
export const recordTemplateDescriptionSchema = z.string().trim().max(500);
export const recordTemplateBodySchema = z.string().max(20_000);
export const recordTemplateValuesSchema = z.record(z.string(), z.unknown());

export const recordTemplateSchema = z.object({
  id: z.uuid(),
  database_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  values: recordTemplateValuesSchema,
  body: z.string().nullable(),
  /** 'pack' = installed by a pack, 'user' = authored here or saved from a record. Editing a pack's template leaves it 'pack'. */
  origin: z.enum(['pack', 'user']),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RecordTemplate = z.infer<typeof recordTemplateSchema>;

export const createRecordTemplateSchema = z.object({
  name: recordTemplateNameSchema,
  description: recordTemplateDescriptionSchema.optional(),
  values: recordTemplateValuesSchema.default({}),
  body: recordTemplateBodySchema.optional(),
});
export type CreateRecordTemplate = z.infer<typeof createRecordTemplateSchema>;

/** "Save as template": the template is read off an existing record (its values and its description), so only a name is asked for. */
export const saveRecordAsTemplateSchema = z.object({
  record_id: z.string().min(1),
  name: recordTemplateNameSchema,
  description: recordTemplateDescriptionSchema.optional(),
});
export type SaveRecordAsTemplate = z.infer<typeof saveRecordAsTemplateSchema>;

export const updateRecordTemplateSchema = z
  .object({
    name: recordTemplateNameSchema,
    description: recordTemplateDescriptionSchema.nullable(),
    values: recordTemplateValuesSchema,
    body: recordTemplateBodySchema.nullable(),
  })
  .partial();
export type UpdateRecordTemplate = z.infer<typeof updateRecordTemplateSchema>;

/** Create a record from a template. `values` overrides the template's value for the same field (the title, usually). */
export const applyRecordTemplateSchema = z.object({
  values: recordTemplateValuesSchema.default({}),
});
export type ApplyRecordTemplate = z.infer<typeof applyRecordTemplateSchema>;
