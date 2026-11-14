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
 * toolbar's New / view tabs (#964, #996), chips and pills, and the 44px+ touch targets of the phone inbox. The ONE sized exception is `size="auth"` (44px) for the auth card and the Join screens (#1302).
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-2.5 text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      /**
       * ticket #1302, Otto's SCOPED exception to the single size: `auth` is 44px, for the buttons on the auth card and the invite Join
       * screens ONLY (a phone tap target). It is declared here, in the one place that owns size, and asked for by name; the guard test
       * (`lib/button-single-size-1282.unit.test.ts`) fails if `size="auth"` appears outside the auth and Join files. Everywhere else
       * the size is `default` (28px), and a `size` prop other than `auth` is ignored.
       */
      size: {
        default: 'h-7',
        auth: 'h-11',
      },
      variant: {
        primary: 'bg-primary text-[var(--text-on-dark)] hover:bg-primary-hover',
        secondary: 'bg-card border border-border-default text-ink hover:bg-hover',
        ghost: 'text-ink-secondary hover:bg-hover',
        destructive: 'border border-error text-error hover:bg-error hover:text-[var(--text-on-error)]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof buttonVariants>, 'size'> {
  /**
   * There is one size now, 28px. `'sm'` is accepted (and ignored) so the call sites that already say it, and branches that add one,
   * still compile. `'auth'` is the 44px phone-tap-target exception for the auth card and the Join screens only (#1302, see above).
   */
  size?: 'sm' | 'auth';
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size: size === 'auth' ? 'auth' : 'default' }), className)} {...props} />;
}
