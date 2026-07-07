import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-sm text-ink placeholder:text-faint',
        className,
      )}
      {...props}
    />
  );
}
