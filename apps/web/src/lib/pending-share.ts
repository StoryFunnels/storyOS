'use client';

/**
 * A freshly-built workspace waiting to be shared (#217).
 *
 * Otto's ruling, verbatim: "INVITE-TEAM SHIPS LAST, NOT FIRST... The sequence
 * is: describe your work, land in something real, then share the thing you
 * just made." `/new-workspace` sets this alongside `pending-build.ts`'s own
 * flag; the workspace HOME page (visible once Tyron's full-screen build steps
 * out of the way) is what actually shows the share prompt, so this is a
 * second one-time signal rather than the same one read twice — the build flag
 * is consumed by `TyronConversation` the instant it mounts, long before the
 * user has landed anywhere to see a share prompt.
 */
const keyFor = (ws: string) => `storyos:pending-share:${ws}`;

export function setPendingShare(ws: string, value = true): void {
  window.sessionStorage.setItem(keyFor(ws), String(value));
}

/** Read-and-clear: offered once, on the first landing after this workspace was
 *  built — never again on a later visit, whether it was used or skipped. */
export function takePendingShare(ws: string): boolean {
  if (typeof window === 'undefined') return false;
  const value = window.sessionStorage.getItem(keyFor(ws));
  if (value !== null) window.sessionStorage.removeItem(keyFor(ws));
  return value === 'true';
}
