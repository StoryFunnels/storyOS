/**
 * #427 / #428 — which board columns appear, and in what order.
 *
 * Both tickets land in the same place and #427 says so explicitly ("both live
 * in the same columns useMemo, and shipping them separately means touching it
 * twice"), so the decisions live here as one pure function over an already-built
 * column list. Pure because every rule below is a judgement call that deserves a
 * test, and none of them need React to be true.
 *
 * THE PROBLEM. A board grouped by an 18-value relation produced 18 columns in
 * whatever order the API returned them — not alphabetical, not by number, no
 * intent at all — several of them empty, and a board scrolls horizontally, so
 * the empty ones pushed the real work off-screen.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. Reordering does not touch the grouping
 * field's options. A select board's column order is a property of THE VIEW, so
 * rearranging your board cannot quietly rewrite a schema every other view reads
 * (#427 AC-5).
 */

/** The "no value" bucket id — mirrors board-view.tsx's NO_VALUE. */
export const NO_VALUE = '__none__';

export type ColumnSort = 'natural' | 'alpha' | 'count';

export interface BoardColumnPrefs {
  /**
   * `natural` = the grouping source's own order, which is meaningful for
   * select/workflow (the option order is an editorial decision) and arbitrary
   * for user/relation (API return order). Hence the alternatives.
   */
  column_sort?: ColumnSort;
  /** #428 — drop groups with no cards. Never applies to the no-value bucket. */
  hide_empty_groups?: boolean;
  /**
   * #428 — the no-value bucket gets its OWN switch, copied from the reference
   * tool and worth copying: "No Epic" is a different question from "an epic
   * with no issues". The ungrouped column is usually the triage pile, i.e. the
   * most important one on the board, so sweeping it away with the empty real
   * groups would be the obvious implementation and the wrong one.
   */
  hide_empty_no_value_group?: boolean;
}

interface ArrangeableColumn {
  id: string;
  label: string;
  rows: unknown[];
}

/**
 * A board grouped by DATE is exempt from ordering: its columns are chronological
 * periods, and any other order is meaningless. It is also already immune to the
 * empty-column problem — bucketColumnsFor derives columns from the data, so
 * empties never appear. That lesson was learned for dates in #307 and never
 * generalised, which is how #428 came to be filed.
 */
export function arrangeBoardColumns<T extends ArrangeableColumn>(
  columns: T[],
  prefs: BoardColumnPrefs,
  opts: { groupType: string },
): T[] {
  const isDate = opts.groupType === 'date';
  const noValue = columns.filter((c) => c.id === NO_VALUE);
  let defs = columns.filter((c) => c.id !== NO_VALUE);

  if (prefs.hide_empty_groups) defs = defs.filter((c) => c.rows.length > 0);

  if (!isDate && prefs.column_sort && prefs.column_sort !== 'natural') {
    const sorted = [...defs];
    if (prefs.column_sort === 'alpha') {
      // localeCompare, not `<`: an 18-epic board is exactly where "Épic" sorting
      // after "Zulu" gets noticed.
      sorted.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    } else {
      // Busiest first — the useful reading of "sort by count" on a board is
      // "show me where the work is". Ties keep their natural order, so the
      // result is stable rather than reshuffling on every render.
      sorted.sort((a, b) => b.rows.length - a.rows.length);
    }
    defs = sorted;
  }

  const keepNoValue = noValue.filter(
    (c) => !(prefs.hide_empty_no_value_group && c.rows.length === 0),
  );

  // The no-value bucket stays LAST regardless of sort — it is not a value, so
  // ordering it among the values (alphabetically under "N", or first by count)
  // would be a category error.
  return [...defs, ...keepNoValue];
}

/** Human label for the sort choice, shared by the control and its description. */
export const COLUMN_SORT_LABELS: Record<ColumnSort, string> = {
  natural: 'Field order',
  alpha: 'A → Z',
  count: 'Most cards first',
};
