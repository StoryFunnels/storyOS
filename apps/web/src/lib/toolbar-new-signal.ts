import { useEffect, useSyncExternalStore } from 'react';

/**
 * Ticket #1275 item 10 / Otto 2026-11-13 — the phone's floating "+" is shown wherever the toolbar has no New, and hidden only
 * where the toolbar already has one. Whether a toolbar has a New is decided where the toolbar draws it (view-toolbar.tsx: no
 * New for a dashboard view or a read-only viewer), so the toolbar REPORTS it here and the layout reads it, instead of the
 * layout guessing from the URL (the first attempt hid it on every database page and took it from dashboards at 390).
 *
 * Three states, on purpose: a toolbar with New is mounted (hide the "+"), a toolbar WITHOUT New is mounted (show it), and
 * nothing is mounted yet (still loading, an error, an empty database) — which keeps it hidden, so the corner button does not
 * flash in for the length of a view query and then vanish when the toolbar's own New appears.
 */
let withNew = 0;
let withoutNew = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** A toolbar came on screen; the returned function is it going away. Exported for the state-machine test. */
export function registerToolbarNew(hasNew: boolean): () => void {
  if (hasNew) withNew += 1;
  else withoutNew += 1;
  emit();
  return () => {
    if (hasNew) withNew -= 1;
    else withoutNew -= 1;
    emit();
  };
}

/** Called by the view toolbar with whether IT draws a New. */
export function useReportToolbarNew(hasNew: boolean): void {
  useEffect(() => registerToolbarNew(hasNew), [hasNew]);
}

/** True once a toolbar is on screen and none of the toolbars on screen has a New. */
export function toolbarLacksNew(): boolean {
  return withoutNew > 0 && withNew === 0;
}

export function useToolbarLacksNew(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    toolbarLacksNew,
    () => false,
  );
}
