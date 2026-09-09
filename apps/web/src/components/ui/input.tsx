import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

/** #333: `ref` is accepted so a caller can focus the field when its own
 *  validation rejects it (React 19 passes ref as an ordinary prop). */
export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        /* #628 — `text-prose`, not Tailwind's `text-sm`. Both are 14px, so no
           input changes size; what changes is that the field and its Label now
           read from ONE scale instead of two that can drift apart independently.
           It also picks up the scale's 1.5 leading (21px, from text-sm's 20px),
           which is the other half of the mismatch the ticket measured. */
        'flex h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-prose text-ink placeholder:text-muted',
        className,
      )}
      {...props}
    />
  );
}
