/**
 * #1162 — "open the Display menu" from somewhere that is not the toolbar (the board's all-hidden notice says "Show
 * them in Display"). The menu's open state is private to `DisplayMenu`, so this is the smallest shared seam: a window
 * event the one mounted `DisplayMenu` listens for. Nothing is copied; the same popover, on the same trigger, opens.
 */
export const OPEN_DISPLAY_MENU_EVENT = 'storyos:open-display-menu';

export function requestOpenDisplayMenu(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_DISPLAY_MENU_EVENT));
}
