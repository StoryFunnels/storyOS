/**
 * #838 — the ONE rule for stepping a highlighted index through a result list.
 *
 * The ⌘K palette and the find-in-view results both move a visible highlight with
 * ↑/↓ and open it with Enter. Each keeps its own `index` state (they are
 * different surfaces over different data), but the STEPPING rule is this one
 * function, so the two lists cannot quietly disagree about the ends: ↓ on the
 * last row goes to the first, ↑ on the first goes to the last, and an empty
 * list stays at 0 rather than becoming NaN or -1.
 */
export function stepIndex(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
