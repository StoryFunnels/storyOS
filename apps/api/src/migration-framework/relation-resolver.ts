export interface TitleTarget {
  id: string;
  title: string;
}

/**
 * Build a title(lowercased) → id index for one target database, matching CSV's
 * "match relation cells by title" trick (MN-052) — `null` marks a title shared
 * by two or more records so the caller can warn instead of guessing which one
 * was meant.
 */
export function buildTitleIndex(targets: TitleTarget[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const t of targets) {
    const key = t.title.toLowerCase();
    map.set(key, map.has(key) ? null : t.id);
  }
  return map;
}

/**
 * A relation cell may name several targets, comma-separated — the shape CSV
 * export writes (MN-075), so import must read it back that way or the round-trip
 * silently drops every target but the first. A title containing a comma survives
 * because the source's own parser already unquoted the cell; this only splits
 * the top level.
 */
export function splitTargets(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ResolvedTargets {
  hits: string[];
  warnings: string[];
}

/**
 * Resolve a raw relation cell against a title index, collecting one warning
 * message per miss/ambiguous target instead of failing the whole record — the
 * per-cell degradation contract every importer shares (MN-052 dry-run rules).
 */
export function resolveTargetsByTitle(index: Map<string, string | null>, raw: string): ResolvedTargets {
  const hits: string[] = [];
  const warnings: string[] = [];
  for (const title of splitTargets(raw)) {
    const hit = index.get(title.toLowerCase());
    if (hit === undefined) warnings.push(`no record titled "${title}"`);
    else if (hit === null) warnings.push(`"${title}" is ambiguous`);
    else hits.push(hit);
  }
  return { hits, warnings };
}
