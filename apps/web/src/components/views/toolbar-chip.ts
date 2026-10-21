import { cn } from '@/lib/utils';

/**
 * #992 / #994 — the toolbar's controls, as one set of classes so Filter, Sort, Group, Find and the pinned chips cannot
 * drift apart (the same defect the field surfaces had: each re-drew "a toolbar chip" and the copies diverged).
 * Values are the prototype's `.chip`, `.chip.active`, `.cnum`, `.pmark`, `.findbox` and `.btn`.
 */

/** `.chip` — a 26px chip with a hairline (4px radius: `--r-pill` is 4px in the prototype's TIGHT theme, the one the app matches); `.chip.active` — a gold border and a 10% gold tint. */
export function chipClass(active = false): string {
  return cn(
    'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-chip)] border px-2.5 text-label',
    active
      ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-card))] text-ink'
      : 'border-border-default bg-card text-ink-secondary hover:border-border-strong hover:text-ink',
  );
}

/** `.cnum` — the count badge inside a chip. */
export const CHIP_COUNT =
  'ml-px inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] px-1 text-[10px] font-bold tabular-nums text-ink';

/** `.pmark` — the person glyph that says "your personal filter is on", folded into the Filter chip. */
export const CHIP_PERSON =
  'inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] text-ink';

/** `.findbox` — Find once it is open: a pill with an accent border. */
export const FIND_BOX =
  'relative inline-flex h-[26px] items-center gap-1.5 rounded-[var(--radius-chip)] border border-accent bg-card px-[9px]';

/** `.btn` — the right-hand controls (Display, ⋯): 27px, a stronger hairline, a bold 12px label. */
export const TOOLBAR_BTN =
  'inline-flex h-[27px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] border border-border-strong bg-card px-[11px] text-label font-semibold text-ink hover:bg-hover aria-expanded:bg-hover';
