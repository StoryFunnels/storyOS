/**
 * Split-screen entity panels — pure logic (#146 Phase 1; #166/#167/#168 stacking;
 * #182/#183/#184 fixes).
 *
 * Design: docs/architecture/split-screen-plan.md. Phase 1 shipped ONE side panel
 * beside the record page (desktop ≥ md). Phase 2 extended that to a STACK of
 * panels with peek-rails. This module carries the founder-testing fixes on top:
 *   - #182: symmetric controls + collapse-in-place. Every pane — the primary
 *     record AND every opened panel — exposes the same collapse / maximize·restore
 *     / close controls and behaves identically. Collapsing docks a pane to a rail
 *     ON THE SIDE IT ALREADY OCCUPIES: the primary sits on the left and rails left;
 *     split panels sit on the right and rail right. No cross-screen jump.
 *   - #183: the originating (primary) record is a first-class collapsible pane. It
 *     can collapse to a LEFT rail independently (not only when something else is
 *     maximized) and expand back — modelled by `primaryCollapsed` + the `PRIMARY_ID`
 *     sentinel so collapse/expand/maximize/restore/close all accept the primary.
 *   - #184: rail chrome (rendered by the host) — full-name spine + `title=` tooltip,
 *     an X on the rail, and tooltips on every control.
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

/** Which side of the split area a pane occupies — and therefore which rail it
 * docks to when collapsed (#182). The primary record is always `left`; opened
 * split panels are always `right`, so a collapse never jumps across the screen. */
export type SplitSide = 'left' | 'right';

/** One panel in the stack. `id` is a stable identity minted on open (see `seq`)
 * so rails, controls, and React keys track a panel across collapse/expand without
 * keying on `(db, rec)` — the same record may legitimately be opened twice.
 * `side` records where the panel lives so it collapses IN PLACE (#182). */
export interface SplitPanel {
  id: string;
  target: SplitTarget;
  /** Docked to a peek-rail (#166) when true; a full record pane when false. */
  collapsed: boolean;
  /** The side this panel occupies / rails to. Opened panels are always `right`. */
  side: SplitSide;
}

/** Reserved id for the primary (route) record when it participates in the same
 * collapse/maximize model as the panels (#183). It is never minted for a real
 * panel (those are `panel-{n}`), so it can safely flow through the same actions. */
export const PRIMARY_ID = 'primary';

/**
 * The whole split state: an ordered (left→right) panel stack, whether the primary
 * record is collapsed to its left rail (#183), which pane — if any — is maximized
 * to fill the split area (#167; may be a panel id or `PRIMARY_ID`), plus a
 * monotonic counter used to mint panel ids. Keeping the counter IN state is what
 * lets `reduceSplit` stay pure/deterministic (no `Math.random` / `Date.now`),
 * which the unit tests rely on. The primary record pane is NOT part of `panels`
 * (it's the route's own record, owned by the host); `primaryCollapsed` /
 * `maximizedId === PRIMARY_ID` are how the primary joins the model.
 */
export interface SplitStackState {
  panels: SplitPanel[];
  /** The primary record docked to its own LEFT rail (#183) when true. */
  primaryCollapsed: boolean;
  /** Id of the pane filling the split area (a panel id or `PRIMARY_ID`), or null
   *  for the shared ~50/50 pair. Kept valid (points at a live, non-collapsed
   *  participant) by the reducer. */
  maximizedId: string | null;
  seq: number;
}

/**
 * How many split PANELS may be expanded (non-collapsed) at once. Phase 2 keeps the
 * "active pair" — the primary record plus ONE expanded panel — so opening or
 * expanding beyond this docks the oldest expanded panel to a rail (#168). It's a
 * named constant (not a hardcoded 1) so the capacity rule reads intentionally and
 * a future phase could widen the active set without touching the transitions.
 */
export const MAX_EXPANDED_PANELS = 1;

/** The base (no-panel) state. Used as `useReducer`'s lazy initializer. */
export function emptySplitStack(): SplitStackState {
  return { panels: [], primaryCollapsed: false, maximizedId: null, seq: 0 };
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
  /** #199 — SWAP the active panel's record in place, keeping the panel's identity.
   *  This is queue triage: walking a list with ↑/↓ must change what the one panel
   *  shows, not push a panel per step and leave a rail behind for every row you
   *  passed. Distinct from `open`, which STACKS and stays the behaviour of relation
   *  links inside a record (#166/#168) — both live here so there is one model with
   *  two named transitions, rather than a second stack implementation for lists.
   *  Falls back to `open` when nothing is open yet. */
  | { type: 'replace'; target: SplitTarget }
  /** Dock a pane to its peek-rail (#166/#167/#182). `id` may be a panel id or
   *  `PRIMARY_ID` — the primary docks to its left rail (#183). */
  | { type: 'collapse'; id: string }
  /** Re-expand a pane from its rail (#166/#183). For a panel this docks whatever
   *  was expanded so the active pair is preserved; for the primary it just brings
   *  the primary pane back (and clears a sibling's maximize). */
  | { type: 'expand'; id: string }
  /** Make a pane fill the split area, docking every other participant (#167/#182).
   *  `id` may be a panel id or `PRIMARY_ID`. */
  | { type: 'maximize'; id: string }
  /** Leave maximized mode, back to the shared ~50/50 pair (#167). */
  | { type: 'restore' }
  /** Close a panel; if it was the active pane, the most-recent rail re-expands so
   *  the stack unwinds one level rather than leaving only rails (#168). Closing
   *  `PRIMARY_ID` cannot remove the primary — it restores it to a pane (#184). */
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

/** Keep `maximizedId` only if it still points at a live, non-collapsed participant
 *  — a panel that exists and is expanded, or the primary while it is not collapsed.
 *  The invariant that a maximized pane is always visible. */
function keepMaximized(
  panels: SplitPanel[],
  primaryCollapsed: boolean,
  maximizedId: string | null,
): string | null {
  if (!maximizedId) return null;
  if (maximizedId === PRIMARY_ID) return primaryCollapsed ? null : PRIMARY_ID;
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
      const pushed: SplitPanel = { id, target: action.target, collapsed: false, side: 'right' };
      const panels = collapseOverflow([...state.panels, pushed], id);
      // A fresh open lands as the shared pair, never inheriting a prior maximize.
      return { ...state, panels, maximizedId: null, seq: state.seq + 1 };
    }

    case 'replace': {
      // The active pane is the expanded one (`selectSplitView` picks the same
      // panel: a maximize collapses every sibling, so the maximized panel is also
      // the only expanded one).
      const active = state.panels.find((p) => !p.collapsed);
      if (!active) return reduceSplit(state, { type: 'open', target: action.target });
      if (active.target.db === action.target.db && active.target.rec === action.target.rec) return state;
      // Keeping `id` is the point: the pane is not remounted, rails and React keys
      // do not churn, and a maximized panel stays maximized as you walk the queue.
      return {
        ...state,
        panels: state.panels.map((p) => (p.id === active.id ? { ...p, target: action.target } : p)),
      };
    }

    case 'expand': {
      if (action.id === PRIMARY_ID) {
        if (!state.primaryCollapsed && state.maximizedId !== PRIMARY_ID) return state;
        // Bring the primary back as a pane; a maximized sibling steps down so the
        // shared pair returns.
        const maximizedId =
          state.maximizedId === PRIMARY_ID ? null : keepMaximized(state.panels, false, state.maximizedId);
        return { ...state, primaryCollapsed: false, maximizedId };
      }
      if (!state.panels.some((p) => p.id === action.id)) return state;
      const panels = collapseOverflow(
        state.panels.map((p) => (p.id === action.id ? { ...p, collapsed: false } : p)),
        action.id,
      );
      // Expanding a panel restores the shared pair, so a maximized primary steps down.
      let maximizedId = keepMaximized(panels, state.primaryCollapsed, state.maximizedId);
      if (maximizedId === PRIMARY_ID) maximizedId = null;
      return { ...state, panels, maximizedId };
    }

    case 'collapse': {
      if (action.id === PRIMARY_ID) {
        if (state.primaryCollapsed) return state;
        const maximizedId = keepMaximized(state.panels, true, state.maximizedId);
        return { ...state, primaryCollapsed: true, maximizedId };
      }
      if (!state.panels.some((p) => p.id === action.id)) return state;
      const panels = state.panels.map((p) => (p.id === action.id ? { ...p, collapsed: true } : p));
      return { ...state, panels, maximizedId: keepMaximized(panels, state.primaryCollapsed, state.maximizedId) };
    }

    case 'maximize': {
      if (action.id === PRIMARY_ID) {
        // The primary fills the split area; every panel drops to its right rail.
        const panels = state.panels.map((p) => ({ ...p, collapsed: true }));
        return { ...state, panels, primaryCollapsed: false, maximizedId: PRIMARY_ID };
      }
      if (!state.panels.some((p) => p.id === action.id)) return state;
      // The maximized panel fills the split area; every sibling panel drops to a
      // rail, and the primary docks to its left rail (derived in `selectSplitView`).
      const panels = state.panels.map((p) =>
        p.id === action.id ? { ...p, collapsed: false } : { ...p, collapsed: true },
      );
      return { ...state, panels, maximizedId: action.id };
    }

    case 'restore': {
      if (state.maximizedId === null) return state;
      // #210: leaving a PRIMARY maximize is NOT just clearing the flag. Maximizing
      // the primary collapsed EVERY panel to a rail (see the `maximize` case), so
      // clearing `maximizedId` alone strands them there — the ~50/50 pair never
      // returns and Restore looks like it "does nothing" (founder UAT). Re-expand
      // the most-recent panel (bounded by `collapseOverflow`) so restoring from a
      // primary-maximize is symmetric with restoring from a panel-maximize, where
      // the maximized panel was never collapsed and the pair returns for free.
      if (state.maximizedId === PRIMARY_ID) {
        const last = state.panels[state.panels.length - 1];
        const panels = last
          ? collapseOverflow(
              state.panels.map((p) => (p.id === last.id ? { ...p, collapsed: false } : p)),
              last.id,
            )
          : state.panels;
        return { ...state, panels, maximizedId: null };
      }
      return { ...state, maximizedId: null };
    }

    case 'close': {
      if (action.id === PRIMARY_ID) {
        // The primary can't be removed — "close" from its rail restores it to a
        // pane (#184): un-collapse it and drop any primary-maximize.
        if (!state.primaryCollapsed && state.maximizedId !== PRIMARY_ID) return state;
        const maximizedId = state.maximizedId === PRIMARY_ID ? null : state.maximizedId;
        return { ...state, primaryCollapsed: false, maximizedId };
      }
      const closing = state.panels.find((p) => p.id === action.id);
      if (!closing) return state;
      const wasExpanded = !closing.collapsed;
      let panels = state.panels.filter((p) => p.id !== action.id);
      // The last panel is gone → back to the plain primary-only view.
      if (panels.length === 0) return { panels: [], primaryCollapsed: false, maximizedId: null, seq: state.seq };
      const maximizedId = keepMaximized(
        panels,
        state.primaryCollapsed,
        state.maximizedId === action.id ? null : state.maximizedId,
      );
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
 * A render-ready projection of the stack for the host: the collapsed panels split
 * by the rail SIDE they dock to (#182), the single active split pane (the maximized
 * panel if any, else the lone expanded one), and the primary's state — whether it
 * shows as a pane, sits on its left rail, or fills the area maximized (#183).
 * Deriving this here keeps the host free of stack logic and makes the layout
 * decision unit-testable.
 */
export interface SplitView {
  /** Collapsed panels docked to the LEFT rail (reserved; opened panels rail right). */
  leftRailPanels: SplitPanel[];
  /** Collapsed panels docked to the RIGHT rail — the common case (#182). */
  rightRailPanels: SplitPanel[];
  /** The expanded split panel filling its half (or the whole area if maximized). */
  activePanel: SplitPanel | null;
  /** The active split panel is maximized (fills the split area). */
  activePanelMaximized: boolean;
  /** The primary record is maximized (fills the split area). */
  primaryMaximized: boolean;
  /** Render the primary as a LEFT rail instead of a pane — because it was collapsed
   *  independently (#183) OR a panel is maximized and pushed it aside (#167). */
  primaryOnRail: boolean;
}

export function selectSplitView(state: SplitStackState): SplitView {
  const collapsed = state.panels.filter((p) => p.collapsed);
  const leftRailPanels = collapsed.filter((p) => p.side === 'left');
  const rightRailPanels = collapsed.filter((p) => p.side === 'right');
  const expanded = state.panels.filter((p) => !p.collapsed);
  const maxPanel = expanded.find((p) => p.id === state.maximizedId) ?? null;
  const activePanel = maxPanel ?? expanded[0] ?? null;
  const primaryMaximized = state.maximizedId === PRIMARY_ID;
  const activePanelMaximized = maxPanel !== null;
  const primaryOnRail = !primaryMaximized && (state.primaryCollapsed || activePanelMaximized);
  return {
    leftRailPanels,
    rightRailPanels,
    activePanel,
    activePanelMaximized,
    primaryMaximized,
    primaryOnRail,
  };
}
