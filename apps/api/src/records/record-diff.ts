/** A single field's before/after value, keyed by field id ("title" for the promoted title column). */
export type RecordDiff = Record<string, { from: unknown; to: unknown }>;

/**
 * Compares two full record snapshots (values + title) and returns only the
 * fields that actually differ — the same shape RecordsService.update()
 * writes into activity_events' `payload.diff`.
 *
 * Used by RecordsService.restoreVersion (MN-231) to diff the current row
 * against a stored record_versions snapshot before writing it back, so the
 * restore shows up in the existing MN-027 activity trail exactly like a
 * normal edit would.
 *
 * Deliberately NOT used by update() itself — that path already has its own
 * (differently-shaped, already-shipped) diffing inline, and this ticket's
 * blast radius is high enough that touching working, unrelated code isn't
 * worth the risk for a cosmetic dedupe.
 */
export function diffSnapshots(
  before: { values: Record<string, unknown>; title: string },
  after: { values: Record<string, unknown>; title: string },
): RecordDiff {
  const diff: RecordDiff = {};
  const fieldIds = new Set([...Object.keys(before.values), ...Object.keys(after.values)]);
  for (const fieldId of fieldIds) {
    const prev = before.values[fieldId] ?? null;
    const next = after.values[fieldId] ?? null;
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    diff[fieldId] = { from: prev, to: next };
  }
  if (before.title !== after.title) {
    diff.title = { from: before.title, to: after.title };
  }
  return diff;
}
