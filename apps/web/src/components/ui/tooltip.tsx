'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * The product's tooltip (#807). One component, so a control either has one or
 * visibly doesn't — before this there was no primitive, so every surface
 * improvised: native `title` (≈1s, OS-styled, unplaceable), `aria-label` only
 * (nothing at all to a sighted user), or neither.
 *
 * - 250ms to open, instant when moving between neighbours (a toolbar of eight
 *   icons must not make you wait eight times).
 * - Opens on keyboard focus as well as hover, closes on Escape — Radix.
 * - Collision-aware and portalled, so it flips at window edges and is never
 *   clipped by an overflow-hidden ancestor, and takes no layout space.
 * - Says what the NEXT CLICK DOES, in one or two words. Not a sentence.
 *
 * It is a SIGHTED-user affordance and never a substitute for `aria-label`: the
 * trigger keeps whatever accessible name it has. Do not also set `title` on the
 * same control — you get both, one of them 1s late.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={400}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = 'bottom',
  align = 'center',
}: {
  /** One or two words; what clicking does. */
  label: ReactNode;
  /** A single element that can take a ref and focus (button, link). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild data-has-tooltip="">
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="pointer-events-none z-[var(--z-tooltip)] max-w-[16rem] rounded-[var(--radius-chip)] bg-ink px-2 py-1 text-meta font-medium text-card shadow-[var(--shadow-popover)]"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
