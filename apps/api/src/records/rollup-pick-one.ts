/**
 * #286 — the argmax/argmin half of rollups: order the linked records by ONE
 * field and return a value from the single winning record ("Last Ticket by ID",
 * "Owner of the most recent Order", "Status of the latest Invoice").
 *
 * Why this is not `min`/`max`: those return the extreme value OF THE FIELD they
 * aggregate. There was no way to order by field X and read field Y off the
 * record that won — which is what people actually mean by "latest".
 *
 * Kept as a pure module (no db, no Nest) because the ordering rules are where
 * the subtle bugs live — null handling, mixed types, ties — and they deserve
 * direct tests rather than only being reachable through a seeded database.
 */

export type PickOneOp = 'first' | 'last';

export function isPickOneOp(op: unknown): op is PickOneOp {
  return op === 'first' || op === 'last';
}

/**
 * Total order over the values a rollup may be ordered BY (number, date,
 * text, checkbox). Deliberately conservative:
 *
 *  - numbers compare numerically, dates chronologically, text
 *    case-insensitively (so "Acme" and "acme" don't order by byte value);
 *  - MIXED types never silently interleave — they're bucketed by type first,
 *    so a half-migrated column produces a stable order instead of one that
 *    depends on which rows happen to be in the batch.
 *
 * Null/empty is NOT ordered here at all — `pickOneRow` drops those rows before
 * comparing. A record with no date is not the "most recent" one.
 */
export function compareOrderValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0: {
      // number
      return (a as number) - (b as number);
    }
    case 1: {
      // date, as epoch ms — parsed once per comparison is fine at rollup sizes
      return dateMs(a) - dateMs(b);
    }
    case 2: {
      // checkbox: false before true
      return Number(a as boolean) - Number(b as boolean);
    }
    default: {
      const sa = String(a).toLowerCase();
      const sb = String(b).toLowerCase();
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
  }
}

function rank(v: unknown): number {
  if (typeof v === 'number') return 0;
  if (v instanceof Date) return 1;
  if (typeof v === 'string' && isIsoDate(v)) return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function dateMs(v: unknown): number {
  return v instanceof Date ? v.getTime() : new Date(v as string).getTime();
}

/**
 * An ISO-8601 date or date-time. Anchored and shape-checked rather than handed
 * to `new Date()` and tested for NaN — Date accepts things like "Dec 2026" and
 * would then order a free-text column as dates on some rows only.
 */
function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v);
}

/**
 * The one record a `first`/`last` rollup resolves to, or null.
 *
 * `first` = smallest ordering value, `last` = largest. That is deliberately the
 * WHOLE direction story: a separate `direction` knob alongside `first`/`last`
 * would give two ways to express one thing (and "first, descending" reads as a
 * contradiction to everyone who isn't holding the implementation in their head).
 *
 * Rows whose ordering value is empty are dropped, not sorted last — "the latest
 * Invoice" must never resolve to one with no date at all. Ties break on the
 * record's own id so the answer is stable across requests and across the
 * read-time and materialized paths, which see rows in different orders.
 */
export function pickOneRow<T extends { id: string }>(
  rows: readonly T[],
  op: PickOneOp,
  keyOf: (row: T) => unknown,
): T | null {
  let best: T | null = null;
  let bestKey: unknown;
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined || key === '') continue;
    if (best === null) {
      best = row;
      bestKey = key;
      continue;
    }
    const cmp = compareOrderValues(key, bestKey);
    const wins = cmp === 0 ? row.id < best.id : op === 'last' ? cmp > 0 : cmp < 0;
    if (wins) {
      best = row;
      bestKey = key;
    }
  }
  return best;
}

/** The subset of a `records` row a pick-one rollup reads. */
export interface PickableRow {
  id: string;
  title: string | null;
  number: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  values: unknown;
}

/**
 * One field's value off a target row, for either ORDERING by it or RETURNING it.
 *
 * Column-backed fields are the reason this exists: the title and the system
 * fields (`number`/`id`, `created_at`, `updated_at`, `created_by`, `updated_by`)
 * live in real columns, not the JSONB `values` bag, so reading them by field id
 * yields undefined — which would have made "Last Ticket by ID", the ticket's own
 * headline example, resolve to nothing.
 */
export function rollupFieldValue(
  row: PickableRow,
  def: { id: string; type: string },
  optionLabels: ReadonlyMap<string, string>,
): unknown {
  switch (def.type) {
    case 'title':
      return row.title;
    case 'id':
      return row.number;
    case 'created_at':
      return row.createdAt;
    case 'updated_at':
      return row.updatedAt;
    case 'created_by':
      return row.createdBy ?? null;
    case 'updated_by':
      return row.updatedBy ?? null;
    default:
      break;
  }
  const raw = (row.values as Record<string, unknown> | null)?.[def.id];
  if (raw === undefined || raw === null) return null;
  if (def.type === 'select' || def.type === 'workflow') return optionLabels.get(raw as string) ?? null;
  if (def.type === 'multi_select') {
    return (raw as string[]).map((id) => optionLabels.get(id)).filter(Boolean);
  }
  return raw;
}
