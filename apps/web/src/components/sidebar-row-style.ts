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
 * #742 redesign — REPLACES the old three-level margin scale (space=0 <
 * contents=10 < nested=26) with the design artifact's model: alignment comes
 * from every row sharing ONE fixed icon-gutter column, not from increasing
 * margins. A space's letter-mark and a database's glyph occupy the SAME
 * column, so their LABELS start at the same x — that is "four levels, zero
 * indent steps" (findings 02/12). The single exception is a folder's own
 * children: a folder genuinely CONTAINS its rows rather than merely preceding
 * them, so those get ONE real indent step, 20px, and it is the only one in
 * the whole tree.
 *
 * This also folds in finding 06 (views are siblings of databases, not
 * nested under them) — there is no longer a "view under a database" depth at
 * all, only "row directly in a space" vs. "row inside a folder".
 *
 * - 0 — every row directly in a space: the space header itself, a database,
 *   a folder, a space-level view, a dashboard, a document. One shared edge —
 *   the bug this file exists to prevent (#380) was a dashboard rendering
 *   left of the databases beside it, and "one shared edge" is still the
 *   guarantee, it is just now also the SPACE's own edge, not a step right of
 *   it.
 * - 1 — a row inside a folder. The one real indent step.
 */
export const SIDEBAR_INDENT_PX = { 0: 0, 1: 20 } as const;

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
