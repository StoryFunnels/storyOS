/**
 * #925 — the in-flight marker of an AI-computed field, kept next to the other per-field siblings on `records.computed_values`
 * (`<field_id>:computed_at`, `<field_id>:error`, ticket #620): flat keys, so the jsonb `||` merge every writer uses never has to
 * reconcile a nested object across concurrent writes (#571).
 *
 * `<field_id>:pending_at` is an ISO timestamp, written when a recompute is ENQUEUED and cleared when the job ends (success or
 * failure). A GET on the record carries it, so a client can show the last good value dimmed while the job runs.
 */
export const pendingAtKey = (fieldId: string) => `${fieldId}:pending_at`;

/**
 * A marker older than this reads as "not pending". A worker that died mid-job must not leave a cell saying "computing" for ever.
 * It is deliberately longer than the job's own wall-clock budget (30 s, `TIMEOUT_MS.short`): the marker is written at ENQUEUE, and
 * a job can wait behind others in the queue before it starts, so a cutoff equal to the timeout would drop the marker on a job that
 * is merely waiting. Five minutes is ten timeouts of queue wait, far longer than a healthy queue takes.
 */
export const AI_PENDING_STALE_MS = 5 * 60_000;

const SUFFIX = ':pending_at';

/**
 * The record's `computed_values` as served: every `:pending_at` marker older than the cutoff is dropped, so a stuck marker reads as
 * not-pending. Pure (returns the same object untouched when there is nothing to drop), so a record with no AI fields pays nothing.
 */
export function withoutStalePending(
  computedValues: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): Record<string, unknown> {
  const source = computedValues ?? {};
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (!key.endsWith(SUFFIX)) continue;
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    const fresh = Number.isFinite(at) && now - at < AI_PENDING_STALE_MS;
    if (!fresh) {
      out ??= { ...source };
      delete out[key];
    }
  }
  return out ?? source;
}
