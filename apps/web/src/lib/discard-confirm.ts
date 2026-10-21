/**
 * #962 (r) — "Discard changes?" when Back would close a form that has unsaved edits.
 *
 * The app's confirm dialog lives in a React provider, and the Back engine is not React, so the provider hands its
 * `confirm` to this slot on mount and the engine asks through it. If nothing is registered (a surface outside the
 * provider) the answer is yes: never block a Back on a question nobody can show.
 */
export interface DiscardAsk {
  (options: { title: string; message: string; confirmLabel: string; cancelLabel: string; danger: boolean }): Promise<boolean>;
}

let ask: DiscardAsk | null = null;

export function registerDiscardConfirm(fn: DiscardAsk): () => void {
  ask = fn;
  return () => {
    if (ask === fn) ask = null;
  };
}

export async function askToDiscard(): Promise<boolean> {
  if (!ask) return true;
  return ask({
    title: 'Discard changes?',
    message: 'You have changes that are not saved. If you go back they will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    danger: true,
  });
}
