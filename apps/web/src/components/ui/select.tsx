import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { Ref, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * #627 — the native `<select>`, as a primitive.
 *
 * Button, Input, Label, Dialog and Popover all exist. The one control with no
 * primitive was the one with the most hand-written copies: 114 raw `<select>`
 * elements across 34 files, measured in the ticket #623 audit. Predictably they
 * had drifted — ONE conceptual control rendered at four heights (24/28/32/36px),
 * four text sizes (11/12/13/14px) and two radii (bare `rounded` = 4px on the
 * small ones, `--radius-control` = 6px on the large ones). Nothing failed to
 * compile and nothing was ever reviewed as wrong, which is exactly the
 * one-concept-many-copies shape CLAUDE.md documents for field surfaces (#267,
 * #272, #303) — here on a control nobody had classified as a field surface.
 *
 * The user-visible consequence: 16 files put a 36px `<Input>` next to a
 * 32px-or-shorter raw `<select>` in the same form.
 *
 * THE VARIANTS ARE COPIED FROM WHAT IS ALREADY THERE, deliberately, so that
 * migrating a call site is a rename rather than a restyle. `default` and `sm`
 * reproduce the two dominant class strings exactly, with one addition: the two
 * `disabled:` classes, which are inert unless the select is actually disabled.
 * So migration is pixel-identical for every enabled select, and for a disabled
 * one it starts dimming — which 113 of the 114 raw selects failed to do.
 * `select-variants.unit.test.ts` asserts that parity rather than trusting this
 * comment to stay true.
 *
 *   default  h-9 … px-2 text-sm        ← 16 existing sites, and matches `Input`
 *   sm       h-8 … px-2 text-[13px]    ← 19 existing sites, the most common
 *   xs       h-6 … px-1 text-[12px]    ← 11 existing sites (see the note below)
 *
 * Two things this file does NOT do, on purpose:
 *
 * 1. **It converts nothing.** Introducing the primitive and migrating to it are
 *    separate PRs, one surface at a time, each with a before/after — because
 *    some migrations DO move pixels (below) and that has to be argued in the
 *    open rather than smuggled into a "add a primitive" diff.
 *
 * 2. **It does not touch `appearance`.** The raw selects render the browser's
 *    native chevron and so does this, because a custom indicator would make
 *    every future migration a visual change. If we want one, that is its own
 *    ticket with its own before/after.
 *
 * WHICH EXISTING SIZES HAVE NO VARIANT, and what migrating them will cost:
 *
 *   h-7 / text-[12px]  (10 sites)  → no variant. Nearest is `sm` (h-8/13px):
 *                                     +4px tall, +1px text.
 *   h-6 / text-[11px]  ( 6 sites)  → no variant. Nearest is `xs` (h-6/12px):
 *                                     same height, +1px text.
 *   every h-6/h-7 site             → radius goes 4px → 6px, because `xs` uses
 *                                     the token. That IS the point of having a
 *                                     token, but it is a visual change and is
 *                                     called out here so nobody claims
 *                                     otherwise at migration time.
 *
 * `xs` extends Button's sm/default/lg vocabulary rather than matching it. That
 * is a considered divergence: 11 call sites need a 24px inline select in table
 * toolbars, and omitting the variant would strand them as bespoke forever,
 * which defeats the purpose of the file. Button arguably wants an `xs` for the
 * same reason — a separate ticket, not this one.
 *
 * The text SIZES here are still arbitrary `[Npx]` literals. That is not an
 * oversight: the type-scale decision is open on ticket #624, and inventing a
 * name for 13px before it is decided would mean renaming it twice. These
 * literals get re-notated when #624 lands.
 */
const selectVariants = cva(
  'rounded-[var(--radius-control)] border border-border-default bg-card text-ink disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-9 px-2 text-sm',
        sm: 'h-8 px-2 text-body',
        xs: 'h-6 px-1 text-label',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export interface SelectProps
  extends
    Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    VariantProps<typeof selectVariants> {
  ref?: Ref<HTMLSelectElement>;
}

/**
 * `size` is renamed away from the native numeric `size` attribute (which sets
 * the visible row count on a multi-select) — hence the `Omit` above. Callers
 * that genuinely need the native attribute should reach for a raw `<select>`
 * and say why; no current call site does.
 */
export function Select({ className, size, ref, ...props }: SelectProps) {
  return <select ref={ref} className={cn(selectVariants({ size }), className)} {...props} />;
}

export { selectVariants };
