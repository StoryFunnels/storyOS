import { AI_PENDING_STALE_MS, AI_PENDING_SUFFIX } from '@storyos/schemas';

/**
 * #925 — the marker's key, cutoff and client-side reader are defined ONCE, in `@storyos/schemas` (`pendingAtKey`,
 * `AI_PENDING_STALE_MS`, `aiPendingAt`), so the web cell reads it by the same rule the API writes it. What stays here is the
 * server-only half: dropping stale markers from a record before it is served.
 */
export { AI_PENDING_STALE_MS, pendingAtKey } from '@storyos/schemas';

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
    if (!key.endsWith(AI_PENDING_SUFFIX)) continue;
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    const fresh = Number.isFinite(at) && now - at < AI_PENDING_STALE_MS;
    if (!fresh) {
      out ??= { ...source };
      delete out[key];
    }
  }
  return out ?? source;
}
