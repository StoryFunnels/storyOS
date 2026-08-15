/**
 * #265 — a small undo stack for destructive record actions, plus the rule for
 * when Cmd/Ctrl+Z belongs to us.
 *
 * WHY MODULE STATE, NOT REACT STATE. The acceptance criterion is that undo works
 * "even after changing views". A table view unmounts when you navigate, taking
 * any component-level stack with it — and navigating away is exactly when a user
 * realises what they deleted. This lives outside React so it survives route
 * changes; it is intentionally NOT persisted across reloads, because an undo
 * whose optimistic cache is gone would be a promise we can't keep.
 *
 * Deletes already showed an Undo toast before this existed (since MN-016). The
 * gap this closes is that the toast is on a timer: miss it and the only route
 * back is the trash. The stack outlives the toast.
 */

export interface UndoEntry {
  /** Shown when the undo runs — e.g. "Restored 3 tasks". */
  label: string;
  /** Reverses the action. Must be idempotent-safe: it may be invoked once. */
  run: () => Promise<void>;
}

/**
 * Deliberately shallow. This is a safety net for "oh no, that one", not a
 * document history — an unbounded stack of closures over stale query caches is
 * a memory leak that also grows more likely to fail the further back you go.
 */
const MAX_DEPTH = 25;

const stack: UndoEntry[] = [];

export function pushUndo(entry: UndoEntry): void {
  stack.push(entry);
  if (stack.length > MAX_DEPTH) stack.shift();
}

export function undoDepth(): number {
  return stack.length;
}

/** Drops everything — used when switching workspace, where ids stop being valid. */
export function clearUndo(): void {
  stack.length = 0;
}

/**
 * Pops and runs the most recent entry. Returns its label, or null when there
 * was nothing to undo. On failure the entry is NOT pushed back: a retry loop on
 * a server-side rejection (already restored, record purged, lost access) would
 * just fail again on the next keypress.
 */
export async function runLastUndo(): Promise<{ label: string } | null> {
  const entry = stack.pop();
  if (!entry) return null;
  await entry.run();
  return { label: entry.label };
}

/**
 * Whether a Cmd/Ctrl+Z keydown belongs to the record-undo stack, or to whatever
 * the user is typing in.
 *
 * This is the load-bearing half of the shortcut. Text inputs and the rich-text
 * editor have their OWN native undo, and stealing Cmd-Z mid-sentence to resurrect
 * a record the user deleted a minute ago would be far worse than having no
 * shortcut at all. When focus is in an editable surface we do nothing and let the
 * event through untouched.
 */
export function shouldHandleUndoShortcut(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return true;
  // contenteditable covers BlockNote/TipTap, which is not an <input>.
  return !el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

/**
 * How long a destructive-action toast stays up. Sonner's default (~4s) is tuned
 * for "Copied"; a delete asks the user to make a data-loss decision, and the
 * founder's report on #265 was that they never registered the Undo at all.
 * Cmd-Z still works after this lapses — the toast is the hint, not the only route.
 */
export const DESTRUCTIVE_TOAST_MS = 12_000;
