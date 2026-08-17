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
        'flex h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-sm text-ink placeholder:text-faint',
        className,
      )}
      {...props}
    />
  );
}
