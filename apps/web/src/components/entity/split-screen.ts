/**
 * Split-screen entity panels — pure logic (#146, Phase 1).
 *
 * Design: docs/architecture/split-screen-plan.md. Phase 1 ships ONE side panel
 * beside the record page (desktop ≥ md); stacking/nesting, deep-link URL state,
 * and wiring other surfaces (table cells, search, cards) are deferred to later
 * phases. Everything decision-shaped lives here as pure functions so the
 * mobile-fallback rule and the single-panel state transition are unit-testable
 * without a DOM (the repo's vitest runs in a plain-node environment).
 */

/** A record targeted for opening in the split panel. `rec` is the same route
 * segment the record page uses (a pretty `slug-{number}` or a raw UUID), so the
 * panel's `useQuery(['record', ws, db, rec])` shares React Query's cache with a
 * base page already showing that record (plan §3.1). */
export interface SplitTarget {
  db: string;
  rec: string;
  title?: string | null;
  number?: number | null;
}

/**
 * Mobile-fallback rule (plan §3.3): a relation click opens the split panel only
 * at the `md` breakpoint and above, and only when a split context is present
 * (i.e. we're on the record page, not a bare table view). Modifier / non-primary
 * clicks always fall through to the browser so cmd/ctrl/shift/middle-click keep
 * opening the record in a new tab. Below `md`, this returns false and the caller
 * lets the `<Link>` navigate full-page — exactly the pre-#146 behavior.
 */
export function shouldOpenInSplit(input: {
  hasSplitContext: boolean;
  isDesktop: boolean;
  modifierKey?: boolean;
  button?: number;
}): boolean {
  const { hasSplitContext, isDesktop, modifierKey = false, button = 0 } = input;
  if (!hasSplitContext) return false;
  if (!isDesktop) return false;
  if (modifierKey) return false;
  if (button !== 0) return false;
  return true;
}

/** True when a mouse event carries any modifier that means "open elsewhere"
 * (new tab / window / download) — those must never be swallowed by the split. */
export function hasOpenElsewhereModifier(event: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

export type SplitAction = { type: 'open'; target: SplitTarget } | { type: 'close' };

/**
 * Phase-1 single-panel state transition. Opening always REPLACES the current
 * panel target — there is no stack yet (stacking/collapsing to rails is a later
 * phase, plan §2.2), so clicking a relation inside the panel simply drills the
 * one panel to the new record rather than nesting a second one. Closing clears
 * the panel back to the base (single) view.
 */
export function reduceSplit(_current: SplitTarget | null, action: SplitAction): SplitTarget | null {
  switch (action.type) {
    case 'open':
      return action.target;
    case 'close':
      return null;
  }
}
