/**
 * #1176 — keyboard focus after a refused pick.
 *
 * Picking a candidate by keyboard (arrow keys / Space on a radio) leaves focus on that radio. If the server then refuses the pick (the
 * database was deleted, or it no longer fits), the candidate leaves the list and the focused radio is removed from the page, so the browser
 * drops focus onto the dialog itself and the person has to Tab back to where they were. This puts focus on the row's own selected radio
 * ("Create a new X database here") instead, but ONLY when focus was actually lost: if it sits on something else (they moved on, or are typing
 * elsewhere), it is left alone.
 *
 * Pure over a tiny document shape, so it is a test without a DOM.
 */
export interface FocusDoc {
  activeElement: FocusEl | null;
  body: unknown;
  querySelector(selector: string): FocusEl | null;
}
export interface FocusEl {
  focus?(): void;
  getAttribute(name: string): string | null;
}

/** Whether focus is lost: nothing, the body, or the dialog container itself (what the browser falls back to). */
export function focusIsLost(doc: FocusDoc): boolean {
  const a = doc.activeElement;
  return !a || a === doc.body || a.getAttribute('role') === 'dialog';
}

/** The selector for a row's checked radio. `name` is the database's name in the pack; quotes are escaped so any name is safe. */
export function selectedRadioSelector(name: string): string {
  return `[data-testid="pack-reuse-choice"][data-database="${name.replace(/(["\\])/g, '\\$1')}"] input[type="radio"]:checked`;
}

/** Puts focus on the first refused row's selected radio when focus was lost. Returns whether it moved focus. */
export function restoreFocusAfterRefusal(doc: FocusDoc, names: string[]): boolean {
  if (!focusIsLost(doc)) return false;
  for (const name of names) {
    const radio = doc.querySelector(selectedRadioSelector(name));
    if (radio) {
      radio.focus?.();
      return true;
    }
  }
  return false;
}
