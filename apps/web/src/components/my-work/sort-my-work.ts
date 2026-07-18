import type { NullsPlacement, SortSpec } from '@/components/views/sort-config';

/**
 * My Work's client-side sort (MN-252) — a plain `.ts` module (not `.tsx`) on
 * purpose: apps/web/vitest.config.ts's `*.unit.test.ts` harness is JSX-free
 * (see its own comment — "pure web logic", node environment, no jsx plugin),
 * so this pure sort logic lives here rather than inline in group-config.tsx
 * where it would drag the whole component file's JSX into the test's module
 * graph and break `vitest run`.
 *
 * Mirrors the query layer's precedence + NULLS FIRST/LAST semantics
 * (apps/api/src/records/records.service.ts `query()`), applied here to the
 * already-fetched, already-filtered My Work rows instead of at the DB layer —
 * My Work has no per-group query round trip to attach a `sorts`/`nulls` body to.
 */

/** The subset of group-config.tsx's DenseField this module needs — kept
 * structural (not imported) so this file has zero JSX-file dependencies. */
export interface SortableDenseField {
  api_name: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

export interface MyWorkSortConfig {
  sorts?: SortSpec[];
  sorts_nulls?: NullsPlacement;
}

function isBlankSortValue(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Field-type-aware comparison for one sort key — select compares by option
 * label (mirrors describeCondition's approach in view-toolbar.tsx), dates by
 * timestamp, numbers numerically, everything else as a string. */
function compareSortValues(a: unknown, b: unknown, field: SortableDenseField): number {
  if (field.type === 'select') {
    const label = (v: unknown) => field.options?.find((o) => o.id === v)?.label ?? '';
    return label(a).localeCompare(label(b));
  }
  if (field.type === 'number') return Number(a) - Number(b);
  if (field.type === 'checkbox') return Number(Boolean(a)) - Number(Boolean(b));
  if (field.type === 'date' || field.type === 'created_at' || field.type === 'updated_at') {
    return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  }
  return String(a).localeCompare(String(b));
}

/**
 * Client-side multi-key sort. A stable sort (Array.prototype.sort is stable
 * per spec) so unrelated rows keep their original relative order when every
 * key ties.
 */
export function sortMyWorkRecords<T extends { values: Record<string, unknown> }, F extends SortableDenseField>(
  records: T[],
  fields: F[],
  config: MyWorkSortConfig,
): T[] {
  const sorts = config.sorts ?? [];
  if (sorts.length === 0) return records;
  const nullsFirst = config.sorts_nulls === 'first';
  const specs = sorts
    .map((s) => ({ direction: s.direction, field: fields.find((f) => f.api_name === s.field) }))
    .filter((s): s is { direction: 'asc' | 'desc'; field: F } => Boolean(s.field));
  if (specs.length === 0) return records;

  return [...records].sort((a, b) => {
    for (const spec of specs) {
      const av = a.values[spec.field.api_name];
      const bv = b.values[spec.field.api_name];
      const aBlank = isBlankSortValue(av);
      const bBlank = isBlankSortValue(bv);
      if (aBlank && bBlank) continue;
      if (aBlank) return nullsFirst ? -1 : 1;
      if (bBlank) return nullsFirst ? 1 : -1;
      const cmp = compareSortValues(av, bv, spec.field);
      if (cmp !== 0) return spec.direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}
