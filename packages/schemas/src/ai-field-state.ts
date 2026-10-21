import { z } from 'zod';

/**
 * #925 — the in-flight marker of an AI-computed field, and the ONE definition of how to read it.
 *
 * It lives on the record's `computed_values`, flat next to the other per-field siblings (`<field_id>:computed_at`,
 * `<field_id>:error`, ticket #620), so the jsonb `||` merge every writer uses never has to reconcile a nested object across
 * concurrent writes (#571). `<field_id>:pending_at` is an ISO timestamp, written when a recompute is ENQUEUED and cleared when
 * the job ends (success or failure). A GET on the record carries it, so a client can show the last good value dimmed while the
 * job runs.
 *
 * Shared here, not re-derived by each consumer: the API writes and filters it, the web cell reads it, and a hand-built
 * `${id}:pending_at` string in each is exactly the drift CONTRIBUTING forbids.
 */
export const AI_PENDING_SUFFIX = ':pending_at';
export const pendingAtKey = (fieldId: string) => `${fieldId}${AI_PENDING_SUFFIX}`;

/**
 * A marker older than this reads as "not pending". A worker that died mid-job must not leave a cell saying "computing" for ever.
 * It is deliberately longer than the job's own wall-clock budget (30 s): the marker is written at ENQUEUE, and a job can wait
 * behind others in the queue before it starts, so a cutoff equal to the timeout would drop the marker on a job that is merely
 * waiting. Five minutes is ten timeouts of queue wait, far longer than a healthy queue takes.
 */
export const AI_PENDING_STALE_MS = 5 * 60_000;

/**
 * When this AI field's value on a record was last queued for recompute, or null when no recompute is in flight. A marker that is
 * missing, not a timestamp, or older than `AI_PENDING_STALE_MS` is not pending. The API already drops stale markers before it
 * serves a record; this applies the same rule on the client, where the clock has moved on since the response was built.
 */
export function aiPendingAt(
  computedValues: Record<string, unknown> | null | undefined,
  fieldId: string,
  now: number = Date.now(),
): string | null {
  const raw = computedValues?.[pendingAtKey(fieldId)];
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) && now - at < AI_PENDING_STALE_MS ? raw : null;
}

/**
 * The record as the API serves it (`GET .../records/{rec}`, and each entry of a query's `data`). Typed so the SDK and MCP callers
 * see the shape, including the AI markers, instead of an untyped body.
 */
export const recordResponseSchema = z.object({
  id: z.uuid(),
  /** Per-database sequential public id, the human handle in URLs. */
  number: z.number().int().nullable(),
  title: z.string(),
  /** Stored values keyed by field api_name (relations carry `{id, title}` chips; select values are option ids). */
  values: z.record(z.string(), z.unknown()),
  position: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string().describe('ISO timestamp'),
  updated_at: z.string().describe('ISO timestamp'),
  computed_values: z
    .record(z.string(), z.unknown())
    .describe(
      'Computed values keyed by field id, with per-field siblings for an AI field: ' +
        '`<field_id>` is the last good value; `<field_id>:computed_at` the ISO timestamp it was computed; ' +
        '`<field_id>:error` the last failure, if any (the last good value is kept); ' +
        '`<field_id>:pending_at` the ISO timestamp a recompute was QUEUED, present only while one is in flight, and dropped once older ' +
        'than five minutes so a crashed worker cannot leave a cell "computing" for ever. ' +
        'Read the marker with `aiPendingAt()` from @storyos/schemas rather than building the key by hand.',
    ),
});
export type RecordResponse = z.infer<typeof recordResponseSchema>;

export const queryRecordsResponseSchema = z.object({
  data: z.array(recordResponseSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
