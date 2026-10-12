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

/**
 * #805 — TWO letters, as the artifact draws them (AO, ST, CW, BF, JC): first
 * letters of the first two words, or the first two characters of a single word.
 * One letter collides the moment two spaces share an initial, and
 * "Borderlands Foundation" read as "B".
 */
export function markInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const out = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '').slice(0, 2);
  return (out || '?').toUpperCase();
}


/**
 * #799 — the caret's activation area, WITHOUT taking layout space.
 *
 * The caret glyph is 12px in a 12px gutter (`SidebarRow`), so the button is
 * exactly 12x12: a quarter of WCAG 2.2 SC 2.5.8's 24x24 minimum, on the only
 * control that expands a space or folder. Widening the gutter would move every
 * label and undo #779, so the target grows by an invisible pseudo-element:
 * 12px LEFTWARD (toward the row's own edge) and 6px up and down — a 24x24 box
 * whose right edge stays flush with the glyph. It never grows rightward, where
 * the row's navigation link lives (#449: expanding and opening are different
 * intents and must not share a target).
 *
 * One constant, applied by every caret button, so the three sites cannot drift
 * apart the way the glyph sizes nearly did. `relative` is part of it because
 * the pseudo-element positions against the button.
 */
export const CARET_HIT_AREA =
  "relative before:absolute before:-inset-y-1.5 before:-left-3 before:right-0 before:content-['']";
