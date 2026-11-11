/**
 * #1253 — when Quill shows in a WAITING state (Otto's ruling, 2026-10-23): not before about a second, so a quick wait stays a plain
 * spinner; and once she has appeared, not for less than about 600ms, so she never flashes. The two numbers are named once, here.
 *
 * Pure, so the timing is tested with plain numbers (the unit tests run in node, with no DOM to wait in).
 */
export const QUILL_SHOW_AFTER_MS = 1000;
export const QUILL_MIN_VISIBLE_MS = 600;

export type QuillWaitView = {
  /** Draw Quill now. */
  showQuill: boolean;
  /** The wait is over AND nothing is being held for her: the screen may move on to the result. */
  settled: boolean;
};

/**
 * @param startedAt when the wait began
 * @param endedAt   when the thing finished (success OR failure), or null while it is still running
 * @param now       the clock
 */
export function quillWaitView(startedAt: number, endedAt: number | null, now: number): QuillWaitView {
  // An end that has not happened yet at `now` is still a wait in progress.
  if (endedAt !== null && endedAt > now) endedAt = null;
  const appearsAt = startedAt + QUILL_SHOW_AFTER_MS;
  // She appears only if the wait was still going when the second struck. Finishing at 999ms means she never existed.
  const everAppears = endedAt === null || endedAt >= appearsAt;
  if (endedAt !== null && !everAppears) return { showQuill: false, settled: true };
  const heldUntil = appearsAt + QUILL_MIN_VISIBLE_MS;
  if (endedAt === null) return { showQuill: now >= appearsAt, settled: false };
  // Finished after she appeared: she stays until she has been up for the minimum, then the result replaces her.
  const holding = now < heldUntil;
  return { showQuill: holding, settled: !holding };
}

/** The next instant at which `quillWaitView` changes its answer, so a timer fires exactly once per change (null: nothing pending). */
export function nextQuillWaitChange(startedAt: number, endedAt: number | null, now: number): number | null {
  if (endedAt !== null && endedAt > now) endedAt = null;
  const appearsAt = startedAt + QUILL_SHOW_AFTER_MS;
  if (now < appearsAt) return endedAt !== null && endedAt < appearsAt ? null : appearsAt;
  const heldUntil = appearsAt + QUILL_MIN_VISIBLE_MS;
  if (endedAt !== null && now < heldUntil) return heldUntil;
  return null;
}
