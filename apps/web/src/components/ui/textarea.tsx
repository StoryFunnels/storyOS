import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * #689 — the missing multi-line-text primitive. `ui/input.tsx` renders an
 * `<input>`; a textarea has its own min-height/resize story, so this is its
 * own component, not a prop on Input — matching #688/#689's naming (`sm`/
 * `default`) so the two primitives agree.
 *
 * The base classes are deliberately minimal: border, the `--radius-control`
 * token, and — the one rule enforced unconditionally, not left to each call
 * site to remember — `placeholder:text-muted`. #637/#675 had to fix faint
 * placeholders one hand-rolled textarea at a time, found only by grepping
 * for the broken colour; a shared default is what makes a THIRD sweep
 * unnecessary. A call site that genuinely needs a different placeholder
 * (a couple of Tyron's composers use `text-faint`) overrides it explicitly
 * via `className`, same as any other deliberate per-site difference —
 * background, padding, a custom focus ring — that `cn()` lets win.
 *
 * Sizes reflect the two shapes the 22 hand-rolled call sites had actually
 * converged on (measured on main): most compact editors use ~56px
 * (Tailwind's `h-14` token) with 12px text; most prose-ish fields use ~80px
 * with 13px text. A handful of sites need a bespoke height outside both —
 * each says why at its own call site rather than being forced to fit.
 */
const textareaVariants = cva(
  'w-full rounded-[var(--radius-control)] border border-border-default bg-card text-ink placeholder:text-muted',
  {
    variants: {
      size: {
        sm: 'min-h-14 px-2 py-1 text-label',
        default: 'min-h-20 px-2 py-1.5 text-body',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, size, ref, ...props }: TextareaProps) {
  return <textarea ref={ref} className={cn(textareaVariants({ size }), className)} {...props} />;
}

export { textareaVariants };
