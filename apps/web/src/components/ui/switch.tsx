'use client';

import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/** A minimal accessible toggle switch. */
export function Switch({ checked, onCheckedChange, disabled, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
