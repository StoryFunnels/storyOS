/**
 * The ONE type style of a record's section labels (Properties, Links, Computed, System, Description and the
 * rich-text / relation headings). Ticket #1277 item 1: the page drew three (10px/500 at 0.5px tracking, 12px/500 at 0.6px,
 * and a third on the quiet "+ Description" button), none of them the design's.
 *
 * The design's label: mono, 9px, regular weight, 0.14em (1.26px) tracking, caps. `font-mono` is the platform monospace
 * stack (IBM Plex Mono is not self-hosted, #797), so the face falls back; size, weight, tracking and case match.
 *
 * The colour is `text-muted`, not the design's lighter grey: a label is prose, and the lighter grey (the glyph colour,
 * `text-faint`) is under 4.5:1 on the cream page. A site that wants hover colour adds it beside this, never instead.
 */
export const SECTION_LABEL = 'font-mono text-[9px] font-normal uppercase tracking-[0.14em] text-muted';
