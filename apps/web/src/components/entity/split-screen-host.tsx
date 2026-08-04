'use client';

import { useEffect, useMemo, useReducer } from 'react';
import { ChevronsLeftRight, PanelLeftOpen } from 'lucide-react';
import { useMediaQuery } from '@/lib/use-media-query';
import { RecordDetail } from './record-detail';
import { SplitPanelProvider } from './split-panel-context';
import type { SplitPanelApi } from './split-panel-context';
import { emptySplitStack, reduceSplit, selectSplitView } from './split-screen';
import type { SplitTarget } from './split-screen';

/**
 * Split-screen host (#146; stacking #166/#167/#168). Wraps the record page's
 * primary `RecordDetail` and, on desktop (≥ `md`), a STACK of split panels opened
 * by clicking related records (the click handlers live in `split-panel-context.tsx`).
 * All decision-shaped logic is in `split-screen.ts`; this component only renders
 * the `reduceSplit` state and the `selectSplitView` projection, and wires controls
 * back to the reducer.
 *
 * Layout, left → right:
 *   - Peek-rails (#166) for every collapsed panel — a slim ~28px column with the
 *     record title as a rotated vertical spine; clicking re-expands it. When a
 *     panel is maximized the primary record docks to its own rail here too, so the
 *     maximized pane can fill the whole area (#167).
 *   - The primary record pane (hidden while a panel is maximized).
 *   - The active panel pane — the shared ~50/50 half, or the full width when
 *     maximized. Each panel carries its own collapse + maximize/restore + close
 *     controls in its header.
 *
 * Every pane scrolls independently. Below `md` the entire stack is dropped and the
 * primary record takes the full width (mobile fallback, plan §3.3).
 */
export function RecordSurface({ ws, db, rec }: { ws: string; db: string; rec: string }) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [state, dispatch] = useReducer(reduceSplit, undefined, emptySplitStack);

  // Mobile fallback (plan §3.3): there is no split below `md`. If the viewport
  // shrinks under the breakpoint with panels open, drop the whole stack — the
  // primary record takes the full width, exactly as without this feature.
  useEffect(() => {
    if (!isDesktop && state.panels.length > 0) dispatch({ type: 'reset' });
  }, [isDesktop, state.panels.length]);

  const api = useMemo<SplitPanelApi>(
    () => ({
      isDesktop,
      open: (target: SplitTarget) => dispatch({ type: 'open', target }),
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

  return (
    <SplitPanelProvider value={api}>
      {showStack ? (
        <div className="flex h-full">
          {/* Collapsed panels → peek-rails (#166). */}
          {view.railPanels.map((panel) => (
            <PeekRail
              key={panel.id}
              title={panel.target.title}
              number={panel.target.number}
              onExpand={() => dispatch({ type: 'expand', id: panel.id })}
            />
          ))}

          {/* While a panel is maximized the primary record docks to its own rail
              so the maximized pane fills the area; clicking it restores (#167). */}
          {view.maximized && <PrimaryRail onRestore={() => dispatch({ type: 'restore' })} />}

          {!view.maximized && (
            <div className="min-w-0 flex-1 overflow-y-auto border-r border-border-default">
              <RecordDetail ws={ws} db={db} rec={rec} />
            </div>
          )}

          {view.activePanel && (
            <div className="min-w-0 flex-1 overflow-y-auto">
              <RecordDetail
                ws={ws}
                db={view.activePanel.target.db}
                rec={view.activePanel.target.rec}
                onClose={() => dispatch({ type: 'close', id: view.activePanel!.id })}
                onCollapse={() => dispatch({ type: 'collapse', id: view.activePanel!.id })}
                isMaximized={view.maximized}
                onToggleMaximize={() =>
                  dispatch(
                    view.maximized
                      ? { type: 'restore' }
                      : { type: 'maximize', id: view.activePanel!.id },
                  )
                }
              />
            </div>
          )}
        </div>
      ) : (
        <RecordDetail ws={ws} db={db} rec={rec} />
      )}
    </SplitPanelProvider>
  );
}

/**
 * A collapsed panel's peek-rail (#166): a slim (~28px) vertical column between the
 * primary pane and the sidebar, showing the record's title as a rotated spine.
 * The whole rail is a button so keyboard + pointer users can re-expand it.
 */
function PeekRail({
  title,
  number,
  onExpand,
}: {
  title?: string | null;
  number?: number | null;
  onExpand: () => void;
}) {
  const label = title || 'Untitled';
  return (
    <button
      type="button"
      title={`Expand ${label}`}
      aria-label={`Expand ${label}`}
      onClick={onExpand}
      className="group flex w-7 shrink-0 flex-col items-center gap-2 overflow-hidden border-r border-border-default bg-card py-3 text-muted hover:bg-hover hover:text-ink"
    >
      <ChevronsLeftRight className="h-3.5 w-3.5 shrink-0" />
      <span className="min-h-0 flex-1 truncate text-[12px] [writing-mode:vertical-rl]">{label}</span>
      {number != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-faint">#{number}</span>
      )}
    </button>
  );
}

/**
 * The primary record's rail, shown only while a panel is maximized (#167) so the
 * maximized pane can fill the split area. Clicking it restores the shared pair.
 */
function PrimaryRail({ onRestore }: { onRestore: () => void }) {
  return (
    <button
      type="button"
      title="Restore split view"
      aria-label="Restore split view"
      onClick={onRestore}
      className="group flex w-7 shrink-0 flex-col items-center gap-2 overflow-hidden border-r border-border-default bg-card py-3 text-muted hover:bg-hover hover:text-ink"
    >
      <PanelLeftOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="min-h-0 flex-1 truncate text-[12px] [writing-mode:vertical-rl]">Record</span>
    </button>
  );
}
