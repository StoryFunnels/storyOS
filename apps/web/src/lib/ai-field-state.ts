/**
 * Ticket #620 — what an AI-computed field's cell can honestly say, read from what the API REPORTS.
 *
 * The recompute job writes two sibling keys next to the field's value in the record's
 * `computed_values` (`ai-field.subscriber.ts`): `<fieldId>:computed_at` on a success and
 * `<fieldId>:error` (null on a success, the message on a failure). Those are the only facts the web
 * app is given, so those are the only states drawn:
 *
 *  - failed   — `:error` holds a message. The last good value (if any) is still the field's value.
 *  - computed — `:computed_at` is set and there is no error.
 *  - none     — neither: never computed, or computed before these keys existed.
 *
 * NOT here, deliberately: a "computing" state. The API stores nothing while a job is in flight, and
 * inferring it from `updated_at` vs `computed_at` would light up on every unrelated edit to the
 * record. Drawing that guess would be a state the server never reported.
 */
export type AiFieldState =
  | { kind: 'failed'; reason: string; computedAt: string | null }
  | { kind: 'computed'; computedAt: string }
  | { kind: 'none' };

export function aiFieldState(
  record: { computed_values?: Record<string, unknown> } | null | undefined,
  fieldId: string,
): AiFieldState {
  const cv = record?.computed_values ?? {};
  const error = cv[`${fieldId}:error`];
  const at = cv[`${fieldId}:computed_at`];
  const computedAt = typeof at === 'string' && at ? at : null;
  if (typeof error === 'string' && error.trim()) return { kind: 'failed', reason: error.trim(), computedAt };
  if (computedAt) return { kind: 'computed', computedAt };
  return { kind: 'none' };
}
