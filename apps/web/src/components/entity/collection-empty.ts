/**
 * #642 item 3 — when does a relation section show its Filter/Sort/Fields
 * controls, and when does it collapse to one "+ Add" row?
 *
 * TWO DIFFERENT EMPTIES, and the rule only works if they stay different:
 *
 *   - EMPTY BY NATURE — the relation has no linked records at all. Filter, Sort
 *     and Fields on a list of zero are controls that cannot do anything, and
 *     mounting them says "there is something to narrow here" when there is not.
 *     The section collapses to a single row.
 *   - EMPTY RIGHT NOW — the relation has records, but a filter has narrowed the
 *     visible set to zero. The controls MUST stay: unmounting them here would
 *     trap the person with an active filter and no way to clear it. A dead end.
 *
 * So the test is the UNFILTERED link count (the record's own stored links),
 * never the visible row count; and an active filter or sort keeps the controls
 * even when the link count is zero (a personal override can outlive the rows
 * it was set against).
 */
export function collectionControlsVisible(input: { linkedCount: number; filtersActive: boolean }): boolean {
  return input.linkedCount > 0 || input.filtersActive;
}
