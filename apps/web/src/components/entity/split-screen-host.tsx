'use client';

import { useEffect, useMemo, useReducer } from 'react';
import { useMediaQuery } from '@/lib/use-media-query';
import { RecordDetail } from './record-detail';
import { SplitPanelProvider } from './split-panel-context';
import type { SplitPanelApi } from './split-panel-context';
import { reduceSplit } from './split-screen';

/**
 * Split-screen host (#146, Phase 1). Wraps the record page's `RecordDetail` and,
 * on desktop (≥ `md`), can show ONE second `RecordDetail` in a side panel beside
 * it — opened by clicking a related record from the primary record's own inline
 * relation sections / relation chips (the click handlers live in
 * `split-panel-context.tsx`). This is the whole Phase-1 surface: a simple two-pane
 * 50/50 split with an independent scroll per pane and a Close control on the panel.
 *
 * Deferred to later phases (plan §2.2 / §4): stacking multiple panels + collapsing
 * older ones to ~1cm rails, deep-link `?panel=` URL state, opening the split from
 * table cells / search / cards, and a resizable drag handle. The state here is a
 * single ephemeral target, not a stack.
 */
export function RecordSurface({ ws, db, rec }: { ws: string; db: string; rec: string }) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [panel, dispatch] = useReducer(reduceSplit, null);

  // Mobile fallback (plan §3.3): there is no split below `md`. If the viewport
  // shrinks under the breakpoint while a panel is open, drop it — the primary
  // record takes the full width, exactly as it would have without this feature.
  useEffect(() => {
    if (!isDesktop && panel) dispatch({ type: 'close' });
  }, [isDesktop, panel]);

  const api = useMemo<SplitPanelApi>(
    () => ({ isDesktop, open: (target) => dispatch({ type: 'open', target }) }),
    [isDesktop],
  );

  const showPanel = Boolean(panel) && isDesktop;

  return (
    <SplitPanelProvider value={api}>
      {showPanel ? (
        <div className="flex h-full">
          <div className="min-w-0 flex-1 overflow-y-auto border-r border-border-default">
            <RecordDetail ws={ws} db={db} rec={rec} />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <RecordDetail
              ws={ws}
              db={panel!.db}
              rec={panel!.rec}
              onClose={() => dispatch({ type: 'close' })}
            />
          </div>
        </div>
      ) : (
        <RecordDetail ws={ws} db={db} rec={rec} />
      )}
    </SplitPanelProvider>
  );
}
