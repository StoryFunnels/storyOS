import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

/**
 * #688 — a size scale via cva, following ui/button.tsx's own pattern (not a
 * second component, not a `small` boolean). `ui/button.tsx`'s doc comment on
 * its own `sm` size applies here verbatim: a size variant having smaller text
 * is what a size variant IS, not an inconsistency to "fix".
 *
 * `sm` and `xs` aren't invented — they're the two shapes ten hand-rolled call
 * sites had already converged on independently (h-8/px-2/text-body, and
 * h-7/px-1.5/text-label respectively), measured on main before this ticket.
 * `text-body` (13px) and `text-label` (12px) are already in `lib/utils.ts`'s
 * twMerge font-size classGroups — no new custom key to register there.
 */
const inputVariants = cva(
  'flex w-full rounded-[var(--radius-control)] border border-border-default bg-card text-ink placeholder:text-muted',
  {
    variants: {
      size: {
        /* #628 — `text-prose`, not Tailwind's `text-sm`. Both are 14px, so no
           input changes size; what changes is that the field and its Label now
           read from ONE scale instead of two that can drift apart independently.
           It also picks up the scale's 1.5 leading (21px, from text-sm's 20px),
           which is the other half of the mismatch the ticket measured. */
        default: 'h-9 px-3 text-prose',
        sm: 'h-8 px-2 text-body',
        xs: 'h-7 px-1.5 text-label',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export interface InputProps
  // `size` collides: the native HTML input attribute is a number (visible
  // character width, rarely used and not something any call site here
  // relies on); our `size` variant is the string enum below. Omit the
  // native one so the variant wins outright rather than silently losing to
  // whichever member TypeScript's interface merge picked.
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  /** #333: accepted so a caller can focus the field when its own validation
   *  rejects it (React 19 passes ref as an ordinary prop). */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, size, ref, ...props }: InputProps) {
  return <input ref={ref} className={cn(inputVariants({ size }), className)} {...props} />;
}

export { inputVariants };
