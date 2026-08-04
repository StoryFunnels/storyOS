/**
 * Split-screen entity panels — pure logic (#146 Phase 1; #166/#167/#168 stacking).
 *
 * Design: docs/architecture/split-screen-plan.md. Phase 1 shipped ONE side panel
 * beside the record page (desktop ≥ md). This module extends that to a STACK of
 * panels with peek-rails:
 *   - #166: a collapsed panel docks to a slim vertical peek-rail (a rotated title
 *     spine) and re-expands on click; rails may sit on either side.
 *   - #167: each panel can collapse (→ rail) or maximize (fills the split area,
 *     siblings drop to rails) and restore (back to the shared ~50/50 pair).
 *   - #168: opening a further record pushes the stack — the oldest expanded panel
 *     docks to a rail so the active pair (primary record + one panel) is kept;
 *     the rail accumulates pushed panels, each independently re-expandable, and
 *     close/back unwinds the stack one level at a time.
 *
 * Everything decision-shaped lives here as pure functions so the mobile-fallback
 * rule AND every stack transition are unit-testable without a DOM (the repo's
 * vitest runs in a plain-node environment). The host (`split-screen-host.tsx`)
 * only renders the state this reducer produces and the view `selectSplitView`
 * derives; it holds no branching logic of its own.
 */

/** A record targeted for opening in a split panel. `rec` is the same route
 * segment the record page uses (a pretty `slug-{number}` or a raw UUID), so the
 * panel's `useQuery(['record', ws, db, rec])` shares React Query's cache with a
 * base page already showing that record (plan §3.1). `title`/`number` are carried
 * so a collapsed panel's peek-rail can label its spine without a fetch (#166). */
export interface SplitTarget {
  db: string;
  rec: string;
  title?: string | null;
  number?: number | null;
}

/** One panel in the stack. `id` is a stable identity minted on open (see `seq`)
 * so rails, controls, and React keys track a panel across collapse/expand without
 * keying on `(db, rec)` — the same record may legitimately be opened twice. */
export interface SplitPanel {
  id: string;
  target: SplitTarget;
  /** Docked to a peek-rail (#166) when true; a full record pane when false. */
  collapsed: boolean;
}

/**
 * The whole split state: an ordered (left→right) panel stack, plus which panel —
 * if any — is maximized to fill the split area (#167), plus a monotonic counter
 * used to mint panel ids. Keeping the counter IN state is what lets `reduceSplit`
 * stay pure/deterministic (no `Math.random` / `Date.now`), which the unit tests
 * rely on. The primary record pane is NOT part of this stack — it's the route's
 * own record, owned by the host; the stack holds only the split-opened panels.
 */
export interface SplitStackState {
  panels: SplitPanel[];
  /** Id of the panel filling the split area, or null for the shared ~50/50 pair.
   *  Always references a non-collapsed panel (invariant kept by the reducer). */
  maximizedId: string | null;
  seq: number;
}

/**
 * How many panels may be expanded (non-collapsed) at once. Phase 2 keeps the
 * "active pair" — the primary record plus ONE expanded panel — so opening or
 * expanding beyond this docks the oldest expanded panel to a rail (#168). It's a
 * named constant (not a hardcoded 1) so the capacity rule reads intentionally and
 * a future phase could widen the active set without touching the transitions.
 */
export const MAX_EXPANDED_PANELS = 1;

/** The base (no-panel) state. Used as `useReducer`'s lazy initializer. */
export function emptySplitStack(): SplitStackState {
  return { panels: [], maximizedId: null, seq: 0 };
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

export type SplitAction =
  /** Push a new panel on the right, expanded (#168). Docks older expanded panels
   *  to rails to keep the active pair; a no-op if the same record is already the
   *  expanded panel (guards double-clicks / re-clicking the active relation). */
  | { type: 'open'; target: SplitTarget }
  /** Dock a panel to a peek-rail (#166/#167). */
  | { type: 'collapse'; id: string }
  /** Re-expand a panel from its rail (#166); docks whatever was expanded so the
   *  active pair is preserved. */
  | { type: 'expand'; id: string }
  /** Make a panel fill the split area, docking every sibling panel (#167). */
  | { type: 'maximize'; id: string }
  /** Leave maximized mode, back to the shared ~50/50 pair (#167). */
  | { type: 'restore' }
  /** Close a panel; if it was the active pane, the most-recent rail re-expands so
   *  the stack unwinds one level rather than leaving only rails (#168). */
  | { type: 'close'; id: string }
  /** Drop the entire stack — used by the mobile fallback when the viewport shrinks
   *  below `md` (plan §3.3). */
  | { type: 'reset' };

/**
 * Dock the oldest expanded panels to rails until at most `MAX_EXPANDED_PANELS`
 * remain expanded, never collapsing `keepId` (the panel the caller just brought
 * to the front). This is the single place the "active pair" invariant is enforced,
 * shared by `open` and `expand`.
 */
function collapseOverflow(panels: SplitPanel[], keepId: string): SplitPanel[] {
  const expanded = panels.filter((p) => !p.collapsed);
  if (expanded.length <= MAX_EXPANDED_PANELS) return panels;
  const toCollapse = new Set<string>();
  let over = expanded.length - MAX_EXPANDED_PANELS;
  for (const p of expanded) {
    if (over <= 0) break;
    if (p.id === keepId) continue; // never dock the just-activated panel
    toCollapse.add(p.id);
    over -= 1;
  }
  return panels.map((p) => (toCollapse.has(p.id) ? { ...p, collapsed: true } : p));
}

/** Keep `maximizedId` only if it still points at a non-collapsed panel — the
 *  invariant that a maximized panel is always expanded. */
function validMaximized(panels: SplitPanel[], maximizedId: string | null): string | null {
  if (!maximizedId) return null;
  const panel = panels.find((p) => p.id === maximizedId);
  return panel && !panel.collapsed ? maximizedId : null;
}

/**
 * The stack state transition. Pure and total: unknown ids are no-ops (return the
 * same reference), so a stale control click can never corrupt the stack.
 */
export function reduceSplit(state: SplitStackState, action: SplitAction): SplitStackState {
  switch (action.type) {
    case 'open': {
      // Re-clicking the relation that's already the active pane is a no-op, so
      // double-clicks don't pile up duplicate panels.
      const alreadyActive = state.panels.some(
        (p) => !p.collapsed && p.target.db === action.target.db && p.target.rec === action.target.rec,
      );
      if (alreadyActive) return state;
      const id = `panel-${state.seq}`;
      const pushed: SplitPanel = { id, target: action.target, collapsed: false };
      const panels = collapseOverflow([...state.panels, pushed], id);
      // A fresh open lands as the shared pair, never inheriting a prior maximize.
      return { panels, maximizedId: null, seq: state.seq + 1 };
    }

    case 'expand': {
      if (!state.panels.some((p) => p.id === action.id)) return state;
      const panels = collapseOverflow(
        state.panels.map((p) => (p.id === action.id ? { ...p, collapsed: false } : p)),
        action.id,
      );
      return { ...state, panels, maximizedId: validMaximized(panels, state.maximizedId) };
    }

    case 'collapse': {
      if (!state.panels.some((p) => p.id === action.id)) return state;
      const panels = state.panels.map((p) => (p.id === action.id ? { ...p, collapsed: true } : p));
      return { ...state, panels, maximizedId: validMaximized(panels, state.maximizedId) };
    }

    case 'maximize': {
      if (!state.panels.some((p) => p.id === action.id)) return state;
      // The maximized panel fills the split area; every sibling drops to a rail.
      const panels = state.panels.map((p) =>
        p.id === action.id ? { ...p, collapsed: false } : { ...p, collapsed: true },
      );
      return { ...state, panels, maximizedId: action.id };
    }

    case 'restore':
      return state.maximizedId === null ? state : { ...state, maximizedId: null };

    case 'close': {
      const closing = state.panels.find((p) => p.id === action.id);
      if (!closing) return state;
      const wasExpanded = !closing.collapsed;
      let panels = state.panels.filter((p) => p.id !== action.id);
      const maximizedId = validMaximized(panels, state.maximizedId === action.id ? null : state.maximizedId);
      // Unwind (#168): if closing the active pane leaves only rails, pop the
      // most-recent rail back to expanded so the split steps back a level.
      const last = panels[panels.length - 1];
      if (wasExpanded && last && panels.every((p) => p.collapsed)) {
        panels = panels.map((p) => (p.id === last.id ? { ...p, collapsed: false } : p));
      }
      return { ...state, panels, maximizedId };
    }

    case 'reset':
      return emptySplitStack();
  }
}

/**
 * A render-ready projection of the stack for the host: the collapsed panels (as
 * peek-rails), the single active pane (the maximized panel if any, else the lone
 * expanded one), and whether that pane is maximized (in which case the host also
 * docks the primary record to its own rail). Deriving this here keeps the host
 * free of stack logic and makes the layout decision unit-testable.
 */
export interface SplitView {
  railPanels: SplitPanel[];
  activePanel: SplitPanel | null;
  maximized: boolean;
}

export function selectSplitView(state: SplitStackState): SplitView {
  const railPanels = state.panels.filter((p) => p.collapsed);
  const expanded = state.panels.filter((p) => !p.collapsed);
  const maximized = expanded.find((p) => p.id === state.maximizedId) ?? null;
  const activePanel = maximized ?? expanded[0] ?? null;
  return { railPanels, activePanel, maximized: Boolean(maximized) };
}
