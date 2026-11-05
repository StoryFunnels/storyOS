'use client';

import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export interface MenuOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** #1180 — an optional second line under the label (a one-line tradeoff). Absent: the row is exactly as before. */
  description?: string;
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
  contentClassName,
  disabled,
  align = 'end',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: MenuOption[];
  /** #1118 — size only (a row that must share its width with siblings); the look stays this component's. */
  className?: string;
  /** #1180 — size of the OPEN list only (a list whose rows carry a description needs more than the default 12rem). */
  contentClassName?: string;
  disabled?: boolean;
  /** #1196 — which edge of the trigger the open list lines up with. A menu that opens left-aligned under its button reads as belonging to it. */
  align?: 'start' | 'end';
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TRIGGER, 'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card', className)} aria-label={label} disabled={disabled}>
          <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? '—'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn('max-h-72 w-48 overflow-y-auto', contentClassName)}
        // #1196 — a long list (the hire card's 48 times) opens scrolled to the current value, not to its top.
        ref={(el: HTMLDivElement | null) => el?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'center' })}
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-current={o.value === value ? 'true' : undefined}
            disabled={o.disabled}
            onSelect={() => onChange(o.value)}
            className="justify-between text-label data-[disabled]:opacity-40"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.label}</span>
              {o.description && <span className="block text-muted">{o.description}</span>}
            </span>
            {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary-text" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
