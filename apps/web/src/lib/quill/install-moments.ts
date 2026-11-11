/**
 * #1253 — the words and keys of the pack-install moments that are not markup, so they can be tested without a DOM.
 */

/** The per-viewer hint that hides the "Try these first" tips AND Quill with them (dismissed-hints, ADR-0019): stays dismissed. */
export const QUILL_TIPS_HINT = 'quill-pack-tips';

/**
 * A failed install's text: the REAL error first, then what the person most wants to know. Install is all-or-nothing (ticket #1112), so
 * "Nothing was installed." is true of every failure here. A server message already ending in a full stop is not given a second one.
 */
export function installFailureText(realError: string): string {
  const e = realError.trim().replace(/[\s.]+$/, '');
  return `${e || 'The install did not finish'}. Nothing was installed.`;
}

/** The done toast for an install the person closed the dialog on. No Quill, and no tips: those live in the dialog only. */
export function installReadyToastCopy(packName: string, spaceName: string | null, intoExisting: boolean) {
  if (!spaceName) return { title: `${packName} is ready`, description: 'Everything is in your sidebar.' };
  return {
    title: `${packName} is ready`,
    description: intoExisting ? `${spaceName} now has everything in the pack.` : `A new space, ${spaceName}, is in your sidebar.`,
  };
}

/**
 * Whether the "Try these first" tips (and Quill with them) show on the ready dialog. `dismissed` is the per-viewer hint, `undefined`
 * while it is still loading: that is NOT "show", so the tips never flash for someone who hid them for good. A pack with no lines to say
 * shows nothing, and no Quill standing over an empty box.
 */
export function shouldShowTips(tips: readonly string[], dismissed: boolean | undefined): boolean {
  return tips.length > 0 && dismissed === false;
}

/** Where an install that SUCCEEDED is told: a toast when the dialog was closed on it, else the pack's own landing view, else the dialog. */
export function installSuccessSurface(o: { closedMidInstall: boolean; route: string | null }): 'toast' | 'navigate' | 'dialog' {
  if (o.closedMidInstall) return 'toast';
  return o.route ? 'navigate' : 'dialog';
}

/** Where an install that FAILED is told: never silently. Closed -> a toast that stays; open -> the dialog's failed state. */
export function installFailureSurface(o: { closedMidInstall: boolean }): 'toast' | 'dialog' {
  return o.closedMidInstall ? 'toast' : 'dialog';
}
