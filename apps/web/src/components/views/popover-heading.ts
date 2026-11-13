/**
 * #1281 item 1 — one heading style for the toolbar popovers (Filter, Sort, Display). Each used to draw its own: Filter a
 * mono 9px title, Sort a mono 10px/600 one, Display no title and Figtree 11px/600 section labels.
 *
 * The prototype's value is mono 9px, uppercase, 0.13em tracking, weight 400. The colour is --text-muted, NOT the
 * prototype's --text-faint: these are words a person reads, and faint measures 3.44:1 on the card in light and 3.89:1 in
 * dark (globals.css, #326), under the 4.5:1 that prose needs. Muted is 5.4:1 and 5.7:1.
 */
const MONO_CAPS = 'font-mono text-[9px] font-normal uppercase tracking-[0.13em] text-muted';

/** The title of a popover ("FILTER", "SORT", "DISPLAY"): the first row, on the hairline. */
export const POPOVER_TITLE = MONO_CAPS;

/** A section head inside a popover ("COLUMNS", "ORDERING"): the same type, a block with its own spacing. */
export const POPOVER_SECTION = `block px-2 pb-1 pt-2 ${MONO_CAPS}`;
