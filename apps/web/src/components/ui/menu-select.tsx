'use client';

import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export interface MenuOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

const TRIGGER =
  'inline-flex h-7 min-w-[7rem] max-w-[10rem] items-center gap-1 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-label text-ink hover:bg-hover';

/**
 * #1114 — a single choice drawn as the product's own menu: a bordered trigger that names the
 * current item, a themed list with a check on it. Replaces the native `<select>` whose popup
 * ignored the theme and listed every option in the system's font.
 */
export function MenuSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: MenuOption[];
  /** #1118 — size only (a row that must share its width with siblings); the look stays this component's. */
  className?: string;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TRIGGER, className)} aria-label={label}>
          <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? '—'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-48 overflow-y-auto">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            disabled={o.disabled}
            onSelect={() => onChange(o.value)}
            className="justify-between text-label data-[disabled]:opacity-40"
          >
            <span className="min-w-0 truncate">{o.label}</span>
            {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent-text" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
