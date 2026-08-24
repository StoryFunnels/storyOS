/**
 * #380 — sidebar row geometry as pure functions.
 *
 * Separated from the component so it can be TESTED. This has regressed twice:
 * #219 fixed documents by copying an invisible grip spacer out of DatabaseRow,
 * then #347 added view rows which never inherited that copy, and a space-level
 * dashboard rendered ~10px LEFT of the databases beside it. A fix that lives as
 * a copied spacer cannot protect the component written after it — and an
 * untested one cannot announce when it breaks.
 */

/**
 * Depth is a named scale, not a per-component guess.
 *
 * - 0 — a space. Leftmost.
 * - 1 — everything inside a space: database, folder, space-level dashboard,
 *   document. One shared left edge, a visible step right of the space.
 * - 2 — a view nested under its database, or a folder's children. These
 *   previously disagreed with each other (`ml-4` vs `ml-3`); one value now.
 */
export const SIDEBAR_INDENT_PX = { 0: 0, 1: 10, 2: 26 } as const;

export type SidebarDepth = keyof typeof SIDEBAR_INDENT_PX;

export function sidebarRowIndent(depth: SidebarDepth): number {
  return SIDEBAR_INDENT_PX[depth];
}

/**
 * The active/hover treatment, BACKGROUND ONLY.
 *
 * There used to be an amber inset bar as well
 * (`shadow-[inset_2px_0_0_var(--accent)]`), applied per row type — so a database
 * and the "All records" child it opens were both active and you got TWO stacked
 * bars for ONE location. Two markers, one place.
 */
export function sidebarRowStateClass(active: boolean): string {
  return active ? 'bg-active text-ink' : 'text-ink-secondary hover:bg-hover';
}
