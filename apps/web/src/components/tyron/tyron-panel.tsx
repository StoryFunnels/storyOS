'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Columns2, Maximize2, Minimize2, PanelRightClose, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SPLIT_RATIO_STEP,
  TYRON_RATIO_DEFAULT,
  TYRON_RATIO_KEY,
  clampSplitRatio,
  ratioFromPointer,
  useSplitRatio,
} from '@/lib/split-pane-ratio';
import { useSidebarCollapsed } from '@/lib/sidebar-state';
import { OPEN_TYRON_EVENT, useTyronPanel } from '@/lib/tyron-panel';
import { AgentAvatar } from './agent-avatar';

/**
 * Tyron's docked panel (#356).
 *
 * **This builds almost nothing new, on purpose.** The drag math is
 * `split-pane-ratio.ts` verbatim (`ratioFromPointer`, `clampSplitRatio`, the
 * arrow-key step) and the sidebar hide is `useSidebarCollapsed`'s existing
 * control. Two resize implementations WILL drift into subtly different feels and
 * nothing will fail to compile when they do — #356's own words, and the exact
 * mechanism #380 and #383 both document.
 *
 * What is genuinely new here is only: which pane is on the right, the four-state
 * header, and the FULL state's escape affordance.
 */
export function TyronPanel() {
  const { state, set, open, close } = useTyronPanel();
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  const { ratio, setRatio, persist } = useSplitRatio(TYRON_RATIO_KEY, TYRON_RATIO_DEFAULT);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * What the sidebar was BEFORE entering full, so leaving full restores the
   * user's own preference rather than assuming they want it back.
   *
   * Someone who works with the sidebar hidden and enters full would otherwise
   * find it forced open on exit — the panel deciding a preference that is not
   * its to decide.
   */
  const sidebarBeforeFull = useRef<boolean | null>(null);

  const enterFull = useCallback(() => {
    if (sidebarBeforeFull.current === null) sidebarBeforeFull.current = collapsed;
    setCollapsed(true);
    set('full');
  }, [collapsed, setCollapsed, set]);

  const leaveFull = useCallback(() => {
    if (sidebarBeforeFull.current !== null) {
      setCollapsed(sidebarBeforeFull.current);
      sidebarBeforeFull.current = null;
    }
    set('third');
  }, [setCollapsed, set]);

  // ⌘J / any opener. (#356 asked for ⌘K; the palette has owned that since #254 —
  // see the note in lib/shortcuts.ts.)
  useEffect(() => {
    const onOpen = () => open();
    window.addEventListener(OPEN_TYRON_EVENT, onOpen);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_TYRON_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * Esc leaves FULL.
   *
   * #356 calls this the one place the panel can be worse than no panel at all:
   * FULL hides the sidebar, which is also the normal way back to the workspace,
   * so someone who misses the toggle is in a chat with no visible exit — the same
   * trap #351 documents on the create-workspace screen.
   *
   * Esc only leaves FULL; it does NOT close the panel from a docked width.
   * Esc is already "clear selection / cancel edit" everywhere else, and having it
   * also destroy a conversation in progress would be a nasty surprise.
   */
  useEffect(() => {
    if (state !== 'full') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        leaveFull();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, leaveFull]);

  /**
   * The PAIR's box, not the panel's.
   *
   * This was the flicker: `ratioFromPointer` needs the region the ratio is a
   * fraction OF, and measuring the panel's own rect made the input depend on the
   * output — every pointermove resized the panel, which moved the box, which
   * produced a different ratio for the same cursor position. The divider chased
   * itself across the screen.
   *
   * The pair is the panel's parent (main + divider + panel, see the workspace
   * layout), and its box does NOT change while dragging, which is exactly the
   * property the maths requires.
   */
  const pairBox = useCallback(() => regionRef.current?.parentElement?.getBoundingClientRect(), []);

  // Drag — pointer math delegated, not reimplemented.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const box = pairBox();
      if (!box) return;
      setRatio(ratioFromPointer(e.clientX, box.left, box.width));
    };
    const onUp = (e: PointerEvent) => {
      const box = pairBox();
      if (box) persist(ratioFromPointer(e.clientX, box.left, box.width));
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, setRatio, persist, pairBox]);

  if (state === 'closed') return null;

  const isFull = state === 'full';
  // `ratio` is the MAIN pane's fraction, so the panel takes the remainder.
  const width = isFull ? '100%' : `${Math.round((1 - (state === 'half' ? 0.5 : ratio)) * 100)}%`;

  return (
    <>
      {/* The divider. Absent in full (there is nothing to divide) and below md,
          where #355 owns mobile and the pair layout is not attempted at all. */}
      {!isFull && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Tyron"
          tabIndex={0}
          onPointerDown={(e) => {
            // Capture the pointer so the drag survives the cursor outrunning the
            // 4px divider — without this, a fast drag drops the pointermove
            // stream the moment the cursor leaves the element.
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onDoubleClick={() => persist(TYRON_RATIO_DEFAULT)}
          onKeyDown={(e) => {
            // Arrow nudges, same step as the record pair.
            if (e.key === 'ArrowLeft') persist(clampSplitRatio(ratio - SPLIT_RATIO_STEP));
            if (e.key === 'ArrowRight') persist(clampSplitRatio(ratio + SPLIT_RATIO_STEP));
          }}
          className={cn(
            'hidden w-1 shrink-0 cursor-col-resize bg-border-default/40 transition-colors md:block',
            'hover:bg-[var(--accent)]/50 focus:bg-[var(--accent)]/50 focus:outline-none',
            dragging && 'bg-[var(--accent)]/60',
          )}
        />
      )}
      <div
        ref={regionRef}
        style={{ width: isFull ? undefined : width }}
        className={cn(
          'flex min-h-0 shrink-0 flex-col border-l border-border-default bg-card',
          // #356: below 768px the pair layout is not attempted at all — mobile is #355.
          isFull ? 'flex-1' : 'hidden md:flex',
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-default px-3">
          <span className="flex min-w-0 items-center gap-2">
            <AgentAvatar name="Tyron" size="sm" />
            <span className="truncate text-[13px] font-medium text-ink">Tyron</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            {/* Half / third, the two docked widths. */}
            {!isFull && (
              <button
                type="button"
                onClick={() => set(state === 'half' ? 'third' : 'half')}
                title={state === 'half' ? 'Narrower' : 'Half and half'}
                aria-label={state === 'half' ? 'Narrower' : 'Half and half'}
                className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink"
              >
                <Columns2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => (isFull ? leaveFull() : enterFull())}
              title={isFull ? 'Exit full screen (Esc)' : 'Full screen'}
              aria-label={isFull ? 'Exit full screen' : 'Full screen'}
              className={cn(
                'rounded p-1.5 hover:bg-hover hover:text-ink',
                // In FULL this is the way back, and the sidebar is gone. A muted
                // icon among other muted icons is not good enough for the only
                // visible exit, so it is given the accent and a label.
                isFull ? 'flex items-center gap-1 bg-accent-soft px-2 text-[var(--accent)]' : 'text-muted',
              )}
            >
              {isFull ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              {isFull && <span className="text-[12px] font-medium">Exit full screen</span>}
            </button>
            <button
              type="button"
              onClick={close}
              title="Close Tyron"
              aria-label="Close Tyron"
              className="rounded p-1.5 text-muted hover:bg-hover hover:text-ink"
            >
              {isFull ? <X className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
            </button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <p className="text-[13px] text-muted">
            The conversation lands here in #357b — this ticket is the shell it lives in.
          </p>
        </div>
      </div>
    </>
  );
}
