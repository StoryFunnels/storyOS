import { z } from 'zod';

/**
 * #239 — the Sources framework. A source is a scheduled sync that upserts
 * external items into a normal database by an external key; shapes shared
 * between the API (sources.controller.ts) and the web app's "Sync from…"
 * dialog + settings/connections listing.
 */

export const sourceScheduleSchema = z.enum(['15m', 'hour', 'day']);
export type SourceSchedule = z.infer<typeof sourceScheduleSchema>;

export const sourceStatusSchema = z.enum(['active', 'paused', 'error']);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const sourceRunStatusSchema = z.enum(['running', 'ok', 'error', 'skipped_quota']);
export type SourceRunStatus = z.infer<typeof sourceRunStatusSchema>;

/** `{ external_key: field_id }` — which provider-emitted key writes which field. */
export const sourceFieldMappingSchema = z.record(z.string().min(1), z.uuid());
export type SourceFieldMapping = z.infer<typeof sourceFieldMappingSchema>;

export const createSourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  connection_id: z.uuid(),
  /** Provider registry key, e.g. "youtube.comments" (sources/providers/index.ts). */
  provider_source: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()).default({}),
  field_mapping: sourceFieldMappingSchema,
  /** Must also appear as one of field_mapping's values — the upsert key. */
  external_key_field_id: z.uuid(),
  schedule: sourceScheduleSchema,
});
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  connection_id: z.uuid().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  field_mapping: sourceFieldMappingSchema.optional(),
  external_key_field_id: z.uuid().optional(),
  schedule: sourceScheduleSchema.optional(),
  status: sourceStatusSchema.optional(),
});
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

export const sourceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  connection_id: z.uuid().nullable(),
  provider_source: z.string(),
  config: z.record(z.string(), z.unknown()),
  target_database_id: z.uuid(),
  field_mapping: sourceFieldMappingSchema,
  external_key_field_id: z.uuid(),
  schedule: sourceScheduleSchema,
  status: sourceStatusSchema,
  last_sync_at: z.string().nullable(),
  created_at: z.string(),
});
export type SourceSummary = z.infer<typeof sourceSummarySchema>;

export const sourceRunSummarySchema = z.object({
  id: z.uuid(),
  source_id: z.uuid(),
  status: sourceRunStatusSchema,
  fetched: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  error: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});
export type SourceRunSummary = z.infer<typeof sourceRunSummarySchema>;

/** One entry in the "Sync from…" provider catalog. */
export const sourceProviderDescriptorSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** connections.provider this source's connection must be, e.g. "google". */
  connection_provider: z.string(),
  /** JSON Schema-ish shape for the config form — kept loose; the web dialog
   * renders it generically (string/number/boolean fields, best-effort). */
  config_schema: z.record(z.string(), z.unknown()),
});
export type SourceProviderDescriptorSummary = z.infer<typeof sourceProviderDescriptorSchema>;
