import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Exported (ticket #1186) so a link that must LOOK like a button, "Browse packs", wears the same classes instead of retyping them.
 *
 * ticket #1282, Otto's ruling 2026-11-13: ONE button size everywhere. 28px tall, 13px/500 (`text-body`), 10px side padding. There
 * used to be three (`default` 36px at 14px, `sm` 28px at 13px, `lg` 40px) and pages, dialog footers, card CTAs and auth forms
 * picked between them, so one Settings page read 36px next to another at 28px. The size now lives HERE and nowhere else: a
 * button class outside this file does not set a height, a padding or a text size (`lib/button-single-size-1282.unit.test.ts`
 * derives the pattern from the inventory and fails on a new one). The prototype's 27px at 12/600 is an accepted small gap.
 *
 * The one text size is declared in the BASE string, not in a variant: `cn()` (tailwind-merge) does not know our custom `text-*`
 * tokens, so a size variant that restated it left 14px and 13px both on a link wearing `buttonVariants` (#1186).
 *
 * Not buttons in this sense, so they keep their own geometry: an icon-only control (`HEADER_ACTION_BOX`, `h-6 w-6`), the
 * toolbar's New / view tabs (#964, #996), chips and pills, and the 44px+ touch targets of the phone inbox.
 */
export const buttonVariants = cva(
  'inline-flex h-7 items-center justify-center gap-2 rounded-[var(--radius-control)] px-2.5 text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-[var(--text-on-dark)] hover:bg-primary-hover',
        secondary: 'bg-card border border-border-default text-ink hover:bg-hover',
        ghost: 'text-ink-secondary hover:bg-hover',
        destructive: 'border border-error text-error hover:bg-error hover:text-[var(--text-on-error)]',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** There is one size now. Accepted (and ignored) so the call sites that already say `size="sm"`, and branches that add one, still compile. */
  size?: 'sm';
}

export function Button({ className, variant, size: _size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
