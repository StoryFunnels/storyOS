import { z } from 'zod';

/**
 * #239 — the Sources framework. A source is a scheduled sync that upserts
 * external items into a normal database by an external key; shapes shared
 * between the API (sources.controller.ts) and the web app's "Sync from…"
 * dialog + settings/connections listing.
 */

export const sourceScheduleSchema = z.enum(['15m', 'hour', 'day']);
export type SourceSchedule = z.infer<typeof sourceScheduleSchema>;

/**
 * #340 — a human recurrence schedule that fires at a chosen wall-clock slot
 * (interpreted in UTC), instead of the coarse "every N minutes since creation"
 * `schedule` string above. The three founder-requested patterns:
 *
 *  - `daily`  — every 1 day at `hour:minute` (the DEFAULT for new sources).
 *  - `weekly` — every 1 week on `weekday` (0=Sun … 6=Sat) at `hour:minute`.
 *  - `hourly` — every 1 hour at `minute` past the hour.
 *
 * Persisted alongside (not replacing) `schedule`: a legacy source with no
 * `recurrence` keeps running off its `schedule` string, so nothing that
 * predates this ticket changes behavior. The scheduler still ticks every 60s;
 * `recurrence` only changes WHICH wall-clock instant a run is due at.
 */
export const sourceRecurrenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hourly'),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('weekly'),
    /** 0=Sunday … 6=Saturday, matching JS `Date.getUTCDay()`. */
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);
export type SourceRecurrence = z.infer<typeof sourceRecurrenceSchema>;

/** The default recurrence for a NEW source (#340): daily at 09:00 UTC. Chosen
 * so a fresh YouTube-style source polls once a day rather than every 15 min,
 * which is the quota win the ticket calls out. */
export const DEFAULT_SOURCE_RECURRENCE: SourceRecurrence = { kind: 'daily', hour: 9, minute: 0 };

export const sourceStatusSchema = z.enum(['active', 'paused', 'error']);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** `skipped_cap` (MN-262): a source-level monthly run cap (e.g. Apify's
 * `monthly_run_cap` config) was reached — distinct from `skipped_quota`,
 * which is the shared per-connection API budget from `checkAndConsumeQuota`. */
export const sourceRunStatusSchema = z.enum(['running', 'ok', 'error', 'skipped_quota', 'skipped_cap']);
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
  /** Legacy coarse interval (#239). Optional now that #340 exists — omit both
   * `schedule` and `recurrence` to get the daily-at-09:00 default. */
  schedule: sourceScheduleSchema.optional(),
  /** #340 — human recurrence (daily/weekly/hourly at a wall-clock slot). */
  recurrence: sourceRecurrenceSchema.optional(),
});
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  connection_id: z.uuid().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  field_mapping: sourceFieldMappingSchema.optional(),
  external_key_field_id: z.uuid().optional(),
  schedule: sourceScheduleSchema.optional(),
  recurrence: sourceRecurrenceSchema.optional(),
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
  /** #340 — the human recurrence, or null for a legacy source that only ever
   * had a coarse `schedule`. */
  recurrence: sourceRecurrenceSchema.nullable(),
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
  /** Provider-owned run metadata (MN-262: `{ compute_units, apify_run_id,
   * apify_dataset_id }`) — null for providers whose `sync()` returns none. */
  stats: z.record(z.string(), z.unknown()).nullable(),
});
export type SourceRunSummary = z.infer<typeof sourceRunSummarySchema>;

/** MN-262 — a one-off call into a provider's `discover()` before any source
 * exists yet, so the "Sync from…" dialog can offer point-and-click field
 * mapping instead of asking the user to read the provider's docs. */
export const sourceDiscoverRequestSchema = z.object({
  connection_id: z.uuid(),
  provider_source: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type SourceDiscoverInput = z.infer<typeof sourceDiscoverRequestSchema>;

export const sourceDiscoverResponseSchema = z.object({ keys: z.array(z.string()) });
export type SourceDiscoverResponse = z.infer<typeof sourceDiscoverResponseSchema>;

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
