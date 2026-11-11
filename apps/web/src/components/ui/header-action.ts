/**
 * #1225 — the one size of an icon button that sits in a column / table header (the ⋯ menu trigger, the board's +).
 *
 * WCAG 2.5.8 (target size, minimum) asks for 24x24 CSS px. These were 20 (⋯) and 18 (+), and on a board column the two
 * centres were 22px apart, so the spacing exception failed too. Every header action takes its box from here so a
 * surface can never drift below the minimum on its own.
 *
 * The glyph keeps its own size (14px) — only the hit area grows. `-my-0.5` lifts the 2px each side back out of the
 * layout, so a header row that was 20px tall (the board column's) stays 20px tall: no card moves.
 */
export const HEADER_ACTION_MIN_PX = 24;

export const HEADER_ACTION_BOX = 'flex h-6 w-6 shrink-0 items-center justify-center rounded -my-0.5';

/** The ⋯ of a header: rests at --faint, darkens on hover / focus / open — never hover-only (#900, #999, #1162). */
export const HEADER_MENU_TRIGGER = `${HEADER_ACTION_BOX} text-faint hover:bg-hover hover:text-ink focus-visible:text-ink aria-expanded:bg-hover aria-expanded:text-ink`;

/** A header's + (add a card): same box as the ⋯ beside it, its own resting colour. */
export const HEADER_ADD_BUTTON = `${HEADER_ACTION_BOX} text-muted hover:bg-active`;
