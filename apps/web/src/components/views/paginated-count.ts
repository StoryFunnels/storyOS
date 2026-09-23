/**
 * #755 — the ONE place that decides whether a paginated group/column's row
 * count may be shown as a plain number.
 *
 * board-view.tsx and list-view.tsx both count the rows they are HOLDING and
 * render that as a group's size. That is correct once every page has loaded
 * and wrong before then — a page count wearing a total's costume. Measured on
 * storyos/issues (740 records, page size 100): a header reading "4" actually
 * held 63 rows, understated 15.8x. A wrong number invites checking; a
 * plausible one does not, which is exactly why this needed one shared rule
 * rather than a per-view judgement call each time a header renders a count.
 *
 * NOT in scope: a real per-group total. That needs a grouped aggregate
 * endpoint (#750), which does not exist yet — this only ever describes what
 * has been LOADED, qualified so it can never be misread as a total.
 */
export function groupCountLabel(loadedCount: number, hasMore: boolean): string {
  return hasMore ? `${loadedCount} loaded` : String(loadedCount);
}
