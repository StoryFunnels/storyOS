'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Collision-aware popover primitives (MN-230d). Mirrors the DropdownMenu
 * wrapper (`ui/dropdown-menu.tsx`) but for field/cell editors: Radix's Popper
 * positioning flips/shifts within the viewport instead of clipping, replacing
 * the hand-rolled `absolute left-0 top-full` panels that broke near screen
 * edges (see docs/architecture/mobile-responsive-plan.md, Phase 3).
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-30 rounded-[var(--radius-card)] border border-border-default bg-card shadow-[0_4px_12px_rgba(15,23,41,0.08)] outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/**
 * Anchors a popover to its nearest positioned ancestor instead of a specific
 * trigger element. Existing call sites already render "a `relative` cell,
 * then conditionally mount its editor as a child" — this lets those editor
 * components self-position via Radix/Popper with zero call-site changes: the
 * invisible anchor just fills the parent box, the same rect the old
 * `absolute inset-0`-style panel used.
 */
export function PopoverParentAnchor() {
  return (
    <PopoverAnchor asChild>
      <span className="absolute inset-0" style={{ pointerEvents: 'none' }} />
    </PopoverAnchor>
  );
}
