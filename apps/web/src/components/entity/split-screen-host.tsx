'use client';

import { useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import { ChevronsLeftRight, PanelLeftOpen, X } from 'lucide-react';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { RecordDetail } from './record-detail';
import { SplitPanelProvider } from './split-panel-context';
import type { SplitPanelApi } from './split-panel-context';
import { PRIMARY_ID, emptySplitStack, reduceSplit, selectSplitView } from './split-screen';
import type { SplitTarget } from './split-screen';

/**
 * Split-screen host (#146; stacking #166/#167/#168; fixes #182/#183/#184). Wraps
 * the record page's primary `RecordDetail` and, on desktop (≥ `md`), a STACK of
 * split panels opened by clicking related records (the click handlers live in
 * `split-panel-context.tsx`). All decision-shaped logic is in `split-screen.ts`;
 * this component only renders the `reduceSplit` state and the `selectSplitView`
 * projection, and wires controls back to the reducer.
 *
 * Layout, left → right:
 *   - The primary record — either as a pane on the LEFT, or, when it is collapsed
 *     (#183) or a panel is maximized (#167), as a slim LEFT rail (a rotated title
 *     spine) that expands/restores it.
 *   - The active split panel pane — the shared ~50/50 half, or the full width when
 *     maximized.
 *   - Collapsed split panels as RIGHT rails, docked in place on the side they came
 *     from (#182) — no cross-screen jump.
 *
 * Every pane exposes the SAME controls (collapse · maximize/restore · close) and
 * every rail carries a full-name spine + `title=` tooltip and an X (#184). Every
 * pane scrolls independently. Below `md` the entire stack is dropped and the
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
          {/* Primary as a LEFT rail — collapsed independently (#183) or pushed aside
              by a maximized panel (#167). Expand/close both bring it back. */}
          {view.primaryOnRail && (
            <Rail
              side="left"
              icon={<PanelLeftOpen className="h-3.5 w-3.5 shrink-0" />}
              label="Record"
              closeLabel="Restore"
              onExpand={() =>
                dispatch(view.activePanelMaximized ? { type: 'restore' } : { type: 'expand', id: PRIMARY_ID })
              }
              onClose={() =>
                dispatch(view.activePanelMaximized ? { type: 'restore' } : { type: 'close', id: PRIMARY_ID })
              }
            />
          )}

          {/* Primary pane — with the SAME collapse + maximize/restore controls as a
              panel (#182). Its Close stays route-back (the primary can't be removed
              from the split; use its rail's X to dock/restore it). */}
          {!view.primaryOnRail && (
            <div className="min-w-0 flex-1 overflow-y-auto border-r border-border-default">
              <RecordDetail
                ws={ws}
                db={db}
                rec={rec}
                onCollapse={() => dispatch({ type: 'collapse', id: PRIMARY_ID })}
                isMaximized={view.primaryMaximized}
                onToggleMaximize={() =>
                  dispatch(view.primaryMaximized ? { type: 'restore' } : { type: 'maximize', id: PRIMARY_ID })
                }
              />
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
                isMaximized={view.activePanelMaximized}
                onToggleMaximize={() =>
                  dispatch(
                    view.activePanelMaximized
                      ? { type: 'restore' }
                      : { type: 'maximize', id: view.activePanel!.id },
                  )
                }
              />
            </div>
          )}

          {/* Collapsed panels dock to a RIGHT rail, in place (#182). */}
          {view.rightRailPanels.map((panel) => (
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
      ) : (
        <RecordDetail ws={ws} db={db} rec={rec} />
      )}
    </SplitPanelProvider>
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
