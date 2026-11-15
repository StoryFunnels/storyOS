import { useEffect, useRef } from 'react';

/**
 * #1281 item 6 — Filter and Sort are hand-rolled panels (a backdrop, not Radix), so opening one left focus on the toolbar
 * button and a keyboard user had to Tab to reach anything in it. The Radix menus beside them (column header, Display)
 * already move focus in and give it back on Escape; this gives the two panels the same behaviour.
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first control a person can act on inside `panel`, or the panel itself (tabIndex -1) when it holds none. */
export function focusFirstIn(panel: HTMLElement | null): void {
  if (!panel) return;
  const first = panel.querySelector<HTMLElement>(FOCUSABLE);
  (first ?? panel).focus();
}

/**
 * Attach the returned ref to the panel. When `open` turns true focus moves into it; closing is the caller's business (each
 * panel already owns its Escape handler and returns focus to its own button).
 */
export function usePopoverFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) focusFirstIn(ref.current);
  }, [open]);
  return ref;
}
