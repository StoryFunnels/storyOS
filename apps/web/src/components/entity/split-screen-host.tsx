'use client';

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { ChevronsLeftRight, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_STEP,
  clampSplitRatio,
  ratioFromPointer,
  useSplitRatio,
} from '@/lib/split-pane-ratio';
import { usePathname } from 'next/navigation';
import { RecordDetail, useRecordQuery } from './record-detail';
import { SplitPanelProvider } from './split-panel-context';
import type { SplitPanelApi } from './split-panel-context';
import { PRIMARY_ID, emptySplitStack, reduceSplit, selectSplitView } from './split-screen';
import type { SplitTarget } from './split-screen';

/**
 * Split-screen host (#146; stacking #166/#167/#168; fixes #182/#183/#184; list
 * surfaces #199). Owns the provider, the reducer and the layout for EVERY surface
 * that can open a record beside itself.
 *
 * #199 made one change to the Phase 1 design: the primary pane is no longer
 * hard-wired to a record. It is a render prop, so the left pane can be a record
 * (the record page) or a LIST (My Work, a database view, search results) while the
 * split model — `reduceSplit`, `selectSplitView`, `SplitPanelProvider`,
 * `useOpenRecord` — stays literally the same code. That was the point of the
 * ticket: a list-specific copy of the split logic would have been the next instance
 * of this codebase's commonest defect, one concept implemented twice and drifting.
 * `RecordSurface` and `ListSurface` below are both thin wrappers over this.
 *
 * Layout, left → right:
 *   - The primary pane on the LEFT — or, when it is collapsed (#183) or a panel is
 *     maximized (#167), a slim LEFT rail (a rotated title spine) that restores it.
 *   - The active split panel pane — the shared ~50/50 half, or the full width when
 *     maximized.
 *   - Collapsed split panels as RIGHT rails, docked in place on the side they came
 *     from (#182) — no cross-screen jump.
 *
 * Every pane exposes the SAME controls (collapse · maximize/restore · close) and
 * every rail carries a full-name spine + `title=` tooltip and an X (#184). Every
 * pane scrolls independently. Below `md` the entire stack is dropped and the
 * primary takes the full width (mobile fallback, plan §3.3).
 */

/** What the host hands the primary render prop so the primary can draw the same
 *  collapse / maximize·restore controls a panel draws (#182). `null` handlers are
 *  never passed — outside a split there is simply no stack to control, which is how
 *  the record page renders identically to before when nothing is open. */
export interface PrimaryPaneControls {
  onCollapse: () => void;
  onToggleMaximize: () => void;
  isMaximized: boolean;
}

/**
 * #462 — how the page tells the host what its left pane IS, and how it gets the
 * pane controls back.
 *
 * The host used to be mounted BY each page, so a page could hand both across as
 * props. It now lives in the workspace layout (so the command palette, a sibling
 * of `<main>`, is inside it and a search result can open a panel), which puts the
 * host ABOVE the page instead of around it. Context is what crosses that gap: the
 * page registers its rail label, and reads the collapse / maximize handlers for
 * the pane it occupies.
 *
 * `controls` is `undefined` whenever no panel is open — the same signal the render
 * prop used to carry, so a page renders exactly as it did before the split exists.
 */
interface SplitPrimary {
  controls?: PrimaryPaneControls;
  setLabel: (label: string, number?: number | null) => void;
}

const SplitPrimaryContext = createContext<SplitPrimary | null>(null);

/** Registers what the primary pane's rail spine should say, for as long as this
 *  component is mounted. Safe outside a host: it is then a no-op. */
function useRegisterPrimaryLabel(label: string, number?: number | null) {
  const primary = useContext(SplitPrimaryContext);
  const setLabel = primary?.setLabel;
  useEffect(() => {
    setLabel?.(label, number ?? null);
  }, [setLabel, label, number]);
  return primary?.controls;
}

/**
 * #462 — the state half of the host, mounted at the ROOT of the workspace layout.
 *
 * It renders no layout of its own; it owns the reducer and publishes the context.
 * That placement is the whole point of this ticket: `useOpenRecord` reads the
 * split from React context, so anything that can open a record has to be a
 * DESCENDANT. #199 mounted the host around each page, which covered every in-page
 * surface and missed the one thing that is not in a page — the command palette,
 * rendered near the root of the layout as a sibling of everything else. Wrapping
 * only `<main>` was not enough for the same reason.
 *
 * `SplitArea` below renders the panes, and goes where the panes belong (beside
 * `<main>`). Two components rather than one because the provider has to sit higher
 * in the tree than the thing it draws.
 */
export function SplitHost({ ws, children }: { ws: string; children: ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [state, dispatch] = useReducer(reduceSplit, undefined, emptySplitStack);
  // What the primary pane is, as registered by whichever page is mounted (#462).
  const [primary, setPrimary] = useState<{ label: string; number?: number | null }>({
    label: 'This page',
  });

  /*
   * #462 — the stack is dropped when the primary NAVIGATES, and that is
   * deliberately not a new behaviour: before this ticket every page mounted its
   * own host, so routing to another page unmounted the host and took the panels
   * with it. Hoisting the host to the layout would have silently made a split
   * survive navigation, which is a product decision nobody made. Resetting here
   * keeps the observable behaviour exactly what it has always been, and leaves
   * "should a panel outlive the page it was opened from?" open to be answered on
   * purpose rather than inherited from a refactor.
   */
  const pathname = usePathname();
  useEffect(() => {
    dispatch({ type: 'reset' });
  }, [pathname]);

  // Mobile fallback (plan §3.3): there is no split below `md`. If the viewport
  // shrinks under the breakpoint with panels open, drop the whole stack — the
  // primary takes the full width, exactly as without this feature.
  useEffect(() => {
    if (!isDesktop && state.panels.length > 0) dispatch({ type: 'reset' });
  }, [isDesktop, state.panels.length]);

  const api = useMemo<SplitPanelApi>(
    () => ({
      isDesktop,
      open: (target: SplitTarget) => dispatch({ type: 'open', target }),
      replace: (target: SplitTarget) => dispatch({ type: 'replace', target }),
      collapse: (id: string) => dispatch({ type: 'collapse', id }),
      expand: (id: string) => dispatch({ type: 'expand', id }),
      maximize: (id: string) => dispatch({ type: 'maximize', id }),
      restore: () => dispatch({ type: 'restore' }),
      close: (id: string) => dispatch({ type: 'close', id }),
    }),
    [isDesktop],
  );

  const view = selectSplitView(state);
  const showStack = isDesktop && state.panels.length > 0;

  // #208's pane ratio lives in `SplitArea`, with the divider it drives.

  // #199 — ONE tree, in both the split and no-split cases. The primary is rendered
  // at the same position either way and is HIDDEN, never unmounted, when it docks
  // to its rail — the same "hidden, not unmounted" rule the workspace layout
  // already applies to <main> for Tyron's full mode (#356), and for the same
  // reason: unmounting throws away scroll position, selection and any in-flight
  // edit, so you would come back to the top of a queue you had worked halfway
  // down. Switching between two shapes here is what made the FIRST cut of this
  // ticket remount My Work on every open, silently resetting the active row.
  //
  // `contents` is what keeps the no-split case byte-identical to before: the
  // wrappers generate no boxes, so the primary still lays out and scrolls against
  // <main> exactly as it did, and no sticky header or `h-full` chain is disturbed
  // (MN-117 is explicit that moving the scroll container breaks both).
  const railed = showStack && view.primaryOnRail;

  // The controls the page's own pane draws (#182), and the label setter it uses to
  // name its rail — one object, memoised so registering a label does not re-render
  // the whole page on every host render.
  const primaryApi = useMemo<SplitPrimary>(
    () => ({
      controls: showStack
        ? {
            onCollapse: () => dispatch({ type: 'collapse', id: PRIMARY_ID }),
            onToggleMaximize: () =>
              dispatch(view.primaryMaximized ? { type: 'restore' } : { type: 'maximize', id: PRIMARY_ID }),
            isMaximized: view.primaryMaximized,
          }
        : undefined,
      setLabel: (label, number) => setPrimary({ label, number }),
    }),
    [showStack, view.primaryMaximized],
  );

  // Everything `SplitArea` needs to draw the panes. Internal to this module — the
  // public contract stays `SplitPanelApi` (what opens a record) and `SplitPrimary`
  // (what a page registers).
  const area = useMemo<SplitAreaState>(
    () => ({ ws, state, dispatch, view, showStack, railed, primary, controls: primaryApi.controls }),
    [ws, state, view, showStack, railed, primary, primaryApi.controls],
  );

  return (
    <SplitPanelProvider value={api}>
      <SplitPrimaryContext.Provider value={primaryApi}>
        <SplitAreaContext.Provider value={area}>{children}</SplitAreaContext.Provider>
      </SplitPrimaryContext.Provider>
    </SplitPanelProvider>
  );
}

interface SplitAreaState {
  ws: string;
  state: ReturnType<typeof emptySplitStack>;
  dispatch: (action: Parameters<typeof reduceSplit>[1]) => void;
  view: ReturnType<typeof selectSplitView>;
  showStack: boolean;
  railed: boolean;
  primary: { label: string; number?: number | null };
  controls?: PrimaryPaneControls;
}

const SplitAreaContext = createContext<SplitAreaState | null>(null);

/**
 * #462 — the layout half of the host: the primary pane, the panels beside it, the
 * rails and the divider. Placed where the panes belong (the row that holds
 * `<main>`), while `SplitHost` sits higher and owns the state.
 *
 * Renders the primary alone when nothing is open, so a workspace with no panel is
 * laid out exactly as it was before any of this existed.
 */
export function SplitArea({
  renderPrimary,
  primaryCloseLabel = 'Restore',
}: {
  /** The left pane. Receives the pane controls when a split is open, and
   *  `undefined` when it is not (so the plain full-width case is unchanged). */
  renderPrimary: (controls?: PrimaryPaneControls) => ReactNode;
  primaryCloseLabel?: string;
}) {
  const area = useContext(SplitAreaContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const { ratio, setRatio, persist } = useSplitRatio();

  // No host above us (a route outside the workspace layout): render the primary
  // plainly. Never throw — a missing provider must degrade, not break the page.
  if (!area) return <>{renderPrimary()}</>;

  const { ws, view, showStack, railed, primary, controls, dispatch } = area;

  // #208: the primary + active panel show as a draggable pair. The divider only
  // exists in that shared layout — when a pane is maximized or on a rail there's a
  // single pane and the ratio is inert (the pane just fills with flex-1).
  const pairMode = !view.primaryOnRail && view.activePanel !== null;
  const primaryPaneStyle: CSSProperties | undefined = pairMode
    ? { flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }
    : undefined;

  return (
    <div ref={containerRef} className={showStack ? 'flex min-h-0 min-w-0 flex-1' : 'contents'}>
      {/* Primary as a LEFT rail — collapsed independently (#183) or pushed aside
          by a maximized panel (#167). Expand/close both bring it back. */}
      {railed && (
        <Rail
          side="left"
          icon={<PanelLeftOpen className="h-3.5 w-3.5 shrink-0" />}
          label={primary.label}
          number={primary.number}
          closeLabel={primaryCloseLabel}
          onExpand={() =>
            dispatch(view.activePanelMaximized ? { type: 'restore' } : { type: 'expand', id: PRIMARY_ID })
          }
          onClose={() =>
            dispatch(view.activePanelMaximized ? { type: 'restore' } : { type: 'close', id: PRIMARY_ID })
          }
        />
      )}

      {/* Primary pane — with the SAME collapse + maximize/restore controls as a
          panel (#182). */}
      <div
        className={cn(
          // #462 — no `overflow-y-auto` here any more. When the host was mounted
          // per page this div was the primary's scroller; now that it wraps
          // <main>, <main> is the scroller again — which is what MN-117 requires
          // ("main must be the scroll container, or every view's h-full/overflow
          // -auto and sticky header attach to a scroller that never scrolls").
          // Two nested scrollers here gave the page a dead outer one and detached
          // every sticky table header inside it.
          showStack ? 'flex min-h-0 min-w-0 flex-1 border-r border-border-default' : 'contents',
          railed && 'hidden',
        )}
        style={showStack && !railed ? primaryPaneStyle : undefined}
      >
        {/*
          #424 — the record pane renders every field type a database can hold, so
          it is the widest surface for a bad value to reach: a relation whose
          target was deleted, a formula whose type changed, an attachment field
          pointed at a file that is gone. In split screen a throw here used to take
          BOTH panes and the grid.
        */}
        <ErrorBoundary
          label="This record"
          className={showStack ? 'flex min-h-0 min-w-0 flex-1' : 'contents'}
        >
          {renderPrimary(controls)}
        </ErrorBoundary>
      </div>

      {/* #208: draggable divider between the two panes of the shared pair. */}
      {showStack && pairMode && (
        <SplitPaneDivider ratio={ratio} containerRef={containerRef} onResize={setRatio} onCommit={persist} />
      )}

      {showStack && view.activePanel && (
        <div className="min-w-0 flex-1 overflow-y-auto">
          {/* Each pane gets its OWN boundary: in split screen, one broken record
              must not cost the other one you were comparing it to. */}
          <ErrorBoundary label="This record">
            <RecordDetail
              ws={ws}
              db={view.activePanel.target.db}
              rec={view.activePanel.target.rec}
              onClose={() => dispatch({ type: 'close', id: view.activePanel!.id })}
              onCollapse={() => dispatch({ type: 'collapse', id: view.activePanel!.id })}
              isMaximized={view.activePanelMaximized}
              onToggleMaximize={() =>
                dispatch(
                  view.activePanelMaximized
                    ? { type: 'restore' }
                    : { type: 'maximize', id: view.activePanel!.id },
                )
              }
            />
          </ErrorBoundary>
        </div>
      )}

      {/* Collapsed panels dock to a RIGHT rail, in place (#182). */}
      {showStack &&
        view.rightRailPanels.map((panel) => (
          <Rail
            key={panel.id}
            side="right"
            icon={<ChevronsLeftRight className="h-3.5 w-3.5 shrink-0" />}
            label={panel.target.title || 'Untitled'}
            number={panel.target.number}
            closeLabel="Close"
            onExpand={() => dispatch({ type: 'expand', id: panel.id })}
            onClose={() => dispatch({ type: 'close', id: panel.id })}
          />
        ))}
    </div>
  );
}

/**
 * The record page's surface. Since #462 this no longer mounts a host — the host
 * lives in the workspace layout — it registers what the primary pane is and draws
 * the record with the controls the host hands back. Behaviour is unchanged from
 * #146/#199: with nothing open, this renders exactly the `RecordDetail` it always
 * did.
 */
export function RecordSurface({ ws, db, rec }: { ws: string; db: string; rec: string }) {
  // #325: shares RecordDetail's query key, so this is the already-loaded record,
  // not a second request. Only read for the collapsed rail's title spine — the real
  // record title, not the literal word "Record", because a docked primary was the
  // only spine in the layout that couldn't tell you what it was, precisely when you
  // need it, since docking is how you park a record to look at something else.
  const primary = useRecordQuery(ws, db, rec);
  const controls = useRegisterPrimaryLabel(primary.data?.title || 'Untitled', primary.data?.number);
  return (
    <RecordDetail
      ws={ws}
      db={db}
      rec={rec}
      onCollapse={controls?.onCollapse}
      onToggleMaximize={controls?.onToggleMaximize}
      isMaximized={controls?.isMaximized ?? false}
    />
  );
}

/**
 * #199 — a LIST surface that can open a record beside itself: My Work and the
 * database views. Since #462 it, too, only consumes the layout's host.
 *
 * Two things differ from `RecordSurface`, both because a list is not a record:
 *   - The rail spine is the surface's own name ("My Work", the database name) — a
 *     list has no record title to borrow.
 *   - A list has no record header to hang the collapse / maximize controls on, so
 *     it draws a thin control strip above itself (`ListPaneChrome`) carrying the
 *     SAME three controls, from the same handlers. #199's criterion 3 is that the
 *     list pane collapses to a rail like any other pane, and it does — via
 *     `PRIMARY_ID`, the same path the record page's primary uses.
 *
 * The element shape is the same with and without a split (`contents` when there is
 * no panel), so the list lays out against `<main>` exactly as it did and is never
 * remounted when a panel opens — remounting would throw away scroll position and
 * selection, which is the "losing your place" #199 exists to fix.
 */
export function ListSurface({
  label,
  children,
}: {
  /** Name of the list for its docked rail's spine — "My Work", the database name. */
  label: string;
  children: ReactNode;
}) {
  const controls = useRegisterPrimaryLabel(label);
  return (
    <div className={controls ? 'flex h-full min-h-0 flex-col' : 'contents'}>
      {controls && <ListPaneChrome label={label} controls={controls} />}
      <div className={controls ? 'min-h-0 flex-1 overflow-y-auto' : 'contents'}>{children}</div>
    </div>
  );
}

/**
 * The control strip a list pane gets while a split is open (#199) — the list's
 * equivalent of the record header's split chrome, using the identical icons,
 * tooltips and aria-labels as `record-detail.tsx` so the two panes read as one
 * feature. It appears ONLY inside a split; with no panel open the list renders
 * exactly as it did before this ticket, with no extra bar.
 */
function ListPaneChrome({ label, controls }: { label: string; controls: PrimaryPaneControls }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border-default px-3 py-1.5">
      <span className="truncate text-[13px] font-medium text-muted">{label}</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          title="Collapse"
          aria-label="Collapse to rail"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
          onClick={controls.onCollapse}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={controls.isMaximized ? 'Restore' : 'Maximize'}
          aria-label={controls.isMaximized ? 'Restore split view' : 'Maximize pane'}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
          onClick={controls.onToggleMaximize}
        >
          {controls.isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/**
 * The draggable divider between the two panes of the shared split pair (#208 —
 * the split-panel sibling of #198's record body↔sidebar divider). A thin hairline
 * with a wide invisible hit area; dragging sets the primary pane's fraction of the
 * pair, the active pane takes the rest. Pointer-based (pointerdown captures, window
 * pointermove updates live, pointerup persists); double-click / Home resets to
 * 50/50; arrow keys nudge. `role="separator"` + arrow keys make it accessible.
 *
 * The ratio is derived from the pointer's position within the container (the pair
 * fills it in the common case; when extra panels are docked to a right rail the
 * mapping is a touch approximate but always clamped, never broken).
 */
function SplitPaneDivider({
  ratio,
  containerRef,
  onResize,
  onCommit,
}: {
  ratio: number;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      onResize(ratioFromPointer(e.clientX, rect.left, rect.width));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      setActive(false);
      onCommit(ratioRef.current);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [containerRef, onResize, onCommit]);

  const nudge = (delta: number) => onCommit(clampSplitRatio(ratioRef.current + delta));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize split panes"
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragging.current = true;
        setActive(true);
      }}
      onDoubleClick={() => onCommit(SPLIT_RATIO_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          nudge(-SPLIT_RATIO_STEP); // give the primary less, the panel more
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          nudge(SPLIT_RATIO_STEP);
        } else if (e.key === 'Home') {
          e.preventDefault();
          onCommit(SPLIT_RATIO_DEFAULT);
        }
      }}
      className={cn(
        'group relative -mx-1 w-2 shrink-0 cursor-col-resize touch-none self-stretch',
        active && 'select-none',
      )}
    >
      {/* hairline, brightened on hover / focus / drag */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-default transition-colors',
          'group-hover:bg-border-strong group-focus-visible:bg-[var(--accent)]',
          active && 'bg-[var(--accent)]',
        )}
      />
    </div>
  );
}

/**
 * A collapsed pane's peek-rail (#166/#184): a slim (~32px) vertical column showing
 * the record's full title as a rotated spine (with a `title=` tooltip carrying the
 * complete title) plus an X to close/restore the pane without expanding it first.
 * Used for BOTH the primary's left rail and every panel's right rail, so the two
 * sides look identical; `side` only picks which edge carries the divider border.
 */
function Rail({
  side,
  icon,
  label,
  number,
  onExpand,
  onClose,
  closeLabel,
}: {
  side: 'left' | 'right';
  icon: ReactNode;
  label: string;
  number?: number | null;
  onExpand: () => void;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <div
      className={cn(
        'flex w-8 shrink-0 flex-col items-center gap-1 bg-card py-2 text-muted',
        side === 'left' ? 'border-r border-border-default' : 'border-l border-border-default',
      )}
    >
      <button
        type="button"
        title={closeLabel}
        aria-label={`${closeLabel} ${label}`}
        onClick={onClose}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={label}
        aria-label={`Expand ${label}`}
        onClick={onExpand}
        className="group flex min-h-0 flex-1 flex-col items-center gap-2 overflow-hidden rounded py-1 hover:bg-hover hover:text-ink"
      >
        {icon}
        <span className="min-h-0 flex-1 truncate text-[12px] [writing-mode:vertical-rl]">{label}</span>
      </button>
      {number != null && <span className="shrink-0 text-[10px] tabular-nums text-faint">#{number}</span>}
    </div>
  );
}
