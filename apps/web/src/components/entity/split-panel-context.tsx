'use client';

import { createContext, useContext } from 'react';
import type { MouseEvent } from 'react';
import { hasOpenElsewhereModifier, shouldOpenInSplit } from './split-screen';
import type { SplitTarget } from './split-screen';

/**
 * Split-screen wiring (#146; stacking #166/#167/#168; list surfaces #199). A
 * `SplitPanelProvider` is mounted by `SplitHost` (see `split-screen-host.tsx`),
 * which now backs BOTH the record surface and the list surfaces — My Work, the
 * database views, and search. What changed in #199 is only WHERE the provider is
 * mounted and what fills the primary pane; the context, the reducer and the
 * decision rules below are the same ones Phase 1 shipped. Anywhere the provider is
 * absent the context is null and every consumer falls back to plain navigation, so
 * a surface that has not been wired keeps its existing behavior rather than
 * breaking.
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
  /** #199 — swap the active panel's record in place (queue triage). */
  replace: (target: SplitTarget) => void;
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
 * The ONE entry point every surface uses to open a record — relation links inside
 * a record, and rows in My Work / table / list / board / gallery / feed / search
 * (#199). It opens the split panel when, and only when, a split context is present
 * AND we're at/above `md` AND the click is an unmodified primary click
 * (`shouldOpenInSplit`); otherwise it runs `navigate`, the caller's own
 * full-navigation fallback.
 *
 * `navigate` exists because the surfaces differ in HOW they navigate, not in WHEN:
 * a `<Link>` navigates by doing nothing (let the default fire, so its `href` keeps
 * carrying cmd/middle-click to a new tab), while a row `<div>` navigates with
 * `router.push`. Both hand the *decision* to this hook, so the mobile-fallback and
 * modifier rules have exactly one implementation. Adding a second "does this open
 * a panel?" test in a list component is the drift this codebase keeps reshipping
 * (#375/#380/#383/#399/#408/#422) — call this instead.
 *
 * Safe to call unconditionally: with no provider it always runs `navigate`.
 */
/** The only parts of a click this decision reads. Structural, not `MouseEvent`, so
 *  a keyboard "open" (the table's `e` shortcut, My Work's Enter) can hand over the
 *  same shape instead of forging a synthetic event or duplicating the rule. */
export interface OpenRecordEvent {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
  preventDefault?: () => void;
}

/**
 * How an already-open split reacts to opening another record.
 *   - `stack` — push a panel and dock the previous one to a rail. The behaviour
 *     relation links inside a record have had since #166/#168, unchanged.
 *   - `swap` — replace the open panel's record. What a LIST wants (#199): walking a
 *     queue must not leave a rail behind for every row you passed.
 */
export type OpenRecordMode = 'stack' | 'swap';

export function useOpenRecord(mode: OpenRecordMode = 'stack'): (
  target: SplitTarget,
  event: OpenRecordEvent,
  navigate?: () => void,
) => void {
  const split = useSplitPanel();
  return (target, event, navigate) => {
    if (
      split &&
      shouldOpenInSplit({
        hasSplitContext: true,
        isDesktop: split.isDesktop,
        modifierKey: hasOpenElsewhereModifier(event),
        button: event.button,
      })
    ) {
      event.preventDefault?.();
      if (mode === 'swap') split.replace(target);
      else split.open(target);
      return;
    }
    navigate?.();
  };
}

/**
 * Returns an `onClick` handler for a relation `<Link>` that opens the target in
 * the split panel instead of navigating — when, and only when, a split context
 * is present AND we're at/above `md` AND the click is an unmodified primary
 * click. In every other case it does nothing and lets the `<Link>`'s default
 * navigation happen, so mobile and non-record-page surfaces behave exactly as
 * before. Safe to call unconditionally: with no provider it returns a no-op
 * handler.
 *
 * A `<Link>`-shaped wrapper over `useOpenRecord` (which every other surface calls
 * directly) — the "navigate" case for a link is precisely "do nothing", so there
 * is one decision, not two.
 */
export function useOpenInSplit(): (target: SplitTarget) => (event: MouseEvent) => void {
  const openRecord = useOpenRecord();
  return (target: SplitTarget) => (event: MouseEvent) => openRecord(target, event);
}
