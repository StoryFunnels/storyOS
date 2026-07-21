/** label(lowercased) → option id, for matching a source's text value against a
 * destination select field's live options (shared by CSV and Linear). */
export function buildLabelIndex(options: Array<{ id: string; label: string }>): Map<string, string> {
  return new Map(options.map((o) => [o.label.toLowerCase(), o.id]));
}

/**
 * Resolve a select option id from a label→id map, trying each candidate in
 * order, case-insensitively (#68 / MN-066). Linear's `state.type` only knows
 * categories (started, completed…), so matching on the state *name* first
 * preserves a custom-named state instead of collapsing it to a fallback
 * category; the caller supplies fallback candidates last.
 */
export function pickOption(map: Map<string, string>, ...candidates: Array<string | undefined>): string | null {
  const lower = new Map([...map].map(([label, id]) => [label.toLowerCase(), id]));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const id = map.get(candidate) ?? lower.get(candidate.toLowerCase());
    if (id) return id;
  }
  return null;
}
