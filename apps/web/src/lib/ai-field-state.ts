import { AI_PENDING_SUFFIX, aiPendingAt } from '@storyos/schemas';

/**
 * Ticket #620 — what an AI-computed field's cell can honestly say, read from what the API REPORTS.
 *
 * The recompute job writes sibling keys next to the field's value in the record's `computed_values`
 * (`ai-field.subscriber.ts`): `<fieldId>:computed_at` on a success, `<fieldId>:error` (null on a success, the
 * message on a failure), and — since #925 — `<fieldId>:pending_at`, written when a recompute is QUEUED and cleared
 * when the job ends. Those are the only facts the web app is given, so those are the only states drawn:
 *
 *  - computing — a fresh `:pending_at` marker. Read through `aiPendingAt()` from `@storyos/schemas`, the ONE reader
 *                (a marker older than five minutes reads as not pending, so a dead worker cannot leave a cell
 *                "computing" for ever). It wins over the rest while it lasts: the job is about to rewrite them.
 *  - failed    — `:error` holds a message. The last good value (if any) is still the field's value.
 *  - computed  — `:computed_at` is set and there is no error.
 *  - none      — none of those: never computed, or computed before these keys existed.
 *
 * Never inferred: "computing" is NOT guessed from `updated_at` vs `computed_at` (that goes true on any unrelated
 * edit) or from an empty value (a field that legitimately computed to nothing would say "computing" for ever).
 */
export type AiFieldState =
  | { kind: 'computing'; since: string }
  | { kind: 'failed'; reason: string; computedAt: string | null }
  | { kind: 'computed'; computedAt: string }
  | { kind: 'none' };

export function aiFieldState(
  record: { computed_values?: Record<string, unknown> } | null | undefined,
  fieldId: string,
  now: number = Date.now(),
): AiFieldState {
  const cv = record?.computed_values ?? {};
  const since = aiPendingAt(cv, fieldId, now);
  if (since) return { kind: 'computing', since };
  const error = cv[`${fieldId}:error`];
  const at = cv[`${fieldId}:computed_at`];
  const computedAt = typeof at === 'string' && at ? at : null;
  if (typeof error === 'string' && error.trim()) return { kind: 'failed', reason: error.trim(), computedAt };
  if (computedAt) return { kind: 'computed', computedAt };
  return { kind: 'none' };
}

/** A state that has something to SAY even when the field holds no value: it must not collapse to an empty "Add" ghost. */
export function aiStateSpeaks(state: AiFieldState | undefined): boolean {
  return state?.kind === 'failed' || state?.kind === 'computing';
}

/** How often a screen re-reads a record while an AI recompute is in flight, so "computing" passes to "computed" on its own. */
export const AI_POLL_MS = 3000;

/** True when any AI recompute on this record is still in flight (a fresh `:pending_at` marker for any field). */
export function recordHasPendingAi(
  record: { computed_values?: Record<string, unknown> } | null | undefined,
  now: number = Date.now(),
): boolean {
  const cv = record?.computed_values;
  if (!cv) return false;
  for (const key of Object.keys(cv)) {
    if (!key.endsWith(AI_PENDING_SUFFIX)) continue;
    if (aiPendingAt(cv, key.slice(0, -AI_PENDING_SUFFIX.length), now)) return true;
  }
  return false;
}
