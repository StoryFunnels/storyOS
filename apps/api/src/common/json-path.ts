/**
 * Dot-path getter for the `{payload.a.b.0.c}` token namespace (MN-254's
 * inbound webhook trigger, also used by MN-263's capture action). Array
 * indices are plain numeric path segments — `a.b.0.c` reads `obj.a.b[0].c` —
 * so a JSON array from a webhook body (e.g. a form builder's `answers` list)
 * is addressable without inventing bracket syntax on top of dot-paths.
 *
 * Deliberately permissive, never throws: a path that doesn't resolve (missing
 * key, out-of-range index, indexing into a primitive) returns `undefined` so
 * callers can fall back to their own "—" placeholder, the same way a missing
 * `{Field}` token already does.
 */
export function getJsonPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const parts = trimmed
    .split('.')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}
