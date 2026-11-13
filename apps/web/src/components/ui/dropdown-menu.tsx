'use client';

import { BackLayer } from '@/lib/back-layers';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { PhoneSheetScrim } from './phone-sheet-scrim';

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

/**
 * #1281 — the ONE menu-row geometry: 28px tall (`--menu-item-height`), 12px text, 8px side padding. DropdownMenuItem
 * wears it; a row that must be a plain `<button>` inside a menu or popover (a switch, a checkmark list) imports it
 * instead of copying the numbers, so a Display row and a menu item cannot drift apart.
 */
export const MENU_ITEM_GEOMETRY = 'min-h-[var(--menu-item-height)] px-2 py-1 text-label';

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        align="start"
        sideOffset={4}
        className={cn(
          'phone-sheet z-[var(--z-popover)] min-w-[var(--menu-min-width)] rounded-[var(--radius-popover)] border border-border-default bg-card p-1 shadow-[var(--shadow-popover)]',
          className,
        )}
        {...props}
      >
        {props.children}
        <BackLayer />
        <PhoneSheetScrim />
      </Dropdown.Content>
    </Dropdown.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Dropdown.Item>) {
  return (
    <Dropdown.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded text-ink outline-none data-[highlighted]:bg-hover',
        MENU_ITEM_GEOMETRY,
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Dropdown.Separator>) {
  return <Dropdown.Separator className={cn('my-1 h-px bg-border-default', className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Dropdown.Label>) {
  return (
    <Dropdown.Label
      className={cn('select-none px-2 pb-0.5 pt-1 text-micro font-semibold uppercase tracking-wider text-muted', className)}
      {...props}
    />
  );
}
