import { cva } from 'class-variance-authority';

/**
 * #533 primitive 1 — ONE chip, TWO DECLARED VARIANTS.
 *
 * A "chip" in StoryOS is any small labelled pill: a select value, a workflow
 * state, a priority, a reference to another record. They already shared a shape
 * — 4px radius, px-1.5/py-0.5, gap-1, truncate — but that shape was retyped in
 * two separately-maintained components, so it held by coincidence rather than by
 * construction. This file is that shape, once.
 *
 * THE VARIANTS ARE THE POINT, NOT THE CONSOLIDATION. `filled` (a category
 * value) and `outline` (a reference to a record) are a DELIBERATE inverse pair:
 * relation-cell.tsx's own comment calls the outline treatment "the deliberate
 * visual inverse of OptionChip … so a reference to another record is never
 * confused with a category value". #533's first criterion was originally written
 * as "one chip component adopted everywhere", which taken literally would have
 * erased that distinction in the name of consolidating an accidental one — the
 * opposite of what the ticket exists to do. Mira corrected it; this file
 * implements the correction.
 *
 * So: the thing that must survive is the DISTINCTION. Before, it was a property
 * of two components that happened to differ and could drift or accidentally
 * converge with any edit. Now it is a declared variant, which is what makes the
 * same visual outcome hold on purpose instead of by luck.
 *
 * WHAT THIS DOES NOT OWN, deliberately: max-width, shrink, the element type
 * (span vs anchor) and the children. Those are the call site's context — a chip
 * in a table cell wants `max-w-full`, a chip in a row of references wants
 * `max-w-40 shrink-0` — and field-surfaces.md's rule is that different chrome
 * WRAPS the shared control rather than re-rendering it.
 *
 * The type steps are the role scale (#624/#634), not the `text-[11px]` and
 * `text-[13px]` literals these two call sites carried. text-meta is 11px and
 * text-body is 13px, so the FONT SIZE is unchanged.
 *
 * THE LEADING IS NOT, and I nearly shipped this claiming it was. `text-[11px]`
 * sets no line-height, so it inherited `normal` (~13.5px at 11px); `text-meta`
 * applies the scale's 1.5 ratio (16.5px). Measured in a real table: the filled
 * chip's own box grows 17.50px -> 20.50px. The table ROW does not move — it is
 * fixed at 32px and the cell at 31px, so nothing reflows and no row height
 * changes; the visible delta is a slightly taller tint behind the label.
 *
 * Kept rather than pinned back, on the grounds that `line-height: normal` on an
 * 11px pill was itself off-scale — every other text step in the app is 1.5, and
 * a chip opting out of that is the kind of exception that has to earn itself. It
 * does not: 20.5px inside a 31px cell still has room, and a slightly larger tint
 * is easier to read at 11px, not harder.
 */
export const chipVariants = cva(
  'inline-flex items-center gap-1 truncate rounded-[var(--radius-chip)] px-1.5 py-0.5',
  {
    variants: {
      variant: {
        /** A category value: soft tint of the option's own colour, its ink
         *  derived per theme by `.option-tint` (#638). Below body size on
         *  purpose — a value label is not prose. */
        filled: 'text-meta font-medium',
        /** A reference to another record: outline only, no fill, body size,
         *  normal weight. The inverse of `filled`, and it must stay that way. */
        outline: 'border-[1.4px] border-border-strong text-body text-ink',
      },
    },
    defaultVariants: { variant: 'filled' },
  },
);
