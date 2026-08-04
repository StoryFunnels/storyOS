'use client';

import { createContext, useContext } from 'react';
import type { MouseEvent } from 'react';
import { hasOpenElsewhereModifier, shouldOpenInSplit } from './split-screen';
import type { SplitTarget } from './split-screen';

/**
 * Split-screen wiring (#146; stacking #166/#167/#168). A `SplitPanelProvider` is
 * mounted around the record surface only (see `split-screen-host.tsx`); everywhere
 * else the context is null and relation links keep their existing navigation
 * behavior — that's what keeps the feature contained to the record page.
 * `isDesktop` is the `md`-breakpoint result the host computes once and shares, so
 * consumers apply the same mobile-fallback rule the plan mandates (plan §3.3).
 *
 * `open` is the only method relation links use; the panel-lifecycle methods
 * (`collapse`/`expand`/`maximize`/`restore`/`close`, all keyed by a panel `id`)
 * are exposed so an open panel can drive its own chrome. The host wires each of
 * these straight to the stack reducer.
 */
export interface SplitPanelApi {
  isDesktop: boolean;
  open: (target: SplitTarget) => void;
  collapse: (id: string) => void;
  expand: (id: string) => void;
  maximize: (id: string) => void;
  restore: () => void;
  close: (id: string) => void;
}

const SplitPanelContext = createContext<SplitPanelApi | null>(null);

export const SplitPanelProvider = SplitPanelContext.Provider;

export function useSplitPanel(): SplitPanelApi | null {
  return useContext(SplitPanelContext);
}

/**
 * Returns an `onClick` handler for a relation `<Link>` that opens the target in
 * the split panel instead of navigating — when, and only when, a split context
 * is present AND we're at/above `md` AND the click is an unmodified primary
 * click (`shouldOpenInSplit`). In every other case it does nothing and lets the
 * `<Link>`'s default navigation happen, so mobile and non-record-page surfaces
 * behave exactly as before. Safe to call unconditionally: with no provider it
 * returns a no-op handler.
 */
export function useOpenInSplit(): (target: SplitTarget) => (event: MouseEvent) => void {
  const split = useSplitPanel();
  return (target: SplitTarget) => (event: MouseEvent) => {
    if (!split) return;
    if (
      !shouldOpenInSplit({
        hasSplitContext: true,
        isDesktop: split.isDesktop,
        modifierKey: hasOpenElsewhereModifier(event),
        button: event.button,
      })
    ) {
      return;
    }
    event.preventDefault();
    split.open(target);
  };
}
