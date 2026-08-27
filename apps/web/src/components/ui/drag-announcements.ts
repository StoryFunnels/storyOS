import type { Announcements } from '@dnd-kit/core';

/**
 * What a drag SAYS out loud (#415).
 *
 * Split out of `drag-presentation.tsx` so it can be asserted without mounting
 * React — the guarantee that matters here ("no announcement may contain a
 * uuid") is a property of these strings, and a test that needed a DOM would be
 * skipped the first time it got slow.
 *
 * Read verbatim out of the live `aria-live` region on app.storyos.dev before
 * this existed:
 *
 *   "Picked up draggable item 102568ca-bfdf-4ba8-88b4-cc84d46aecf1."
 *
 * Those are dnd-kit's stock strings with our sortable ids substituted in. Every
 * sortable in this app is keyed by a database / field / record uuid, so the
 * announcement was pure hex — no name, no position, no list length. The live
 * regions themselves were fine; only the text was useless.
 */

/** Resolve a sortable id to something a person can read. */
export type DragLabeller = (id: string) => string | undefined;

export function blockAnnouncements(
  label: DragLabeller,
  /** For "3 of 8". Omit when the list length is not known to the caller. */
  items?: readonly string[],
): Announcements {
  const name = (id: string | number | undefined) => {
    /*
     * Falls back to the WORD "item", never to the id. A label lookup can
     * legitimately miss — a field removed mid-drag, a stale list — and the
     * tempting fallback is `String(id)`, which is exactly the bug this fixes.
     */
    if (id == null) return 'item';
    return label(String(id)) || 'item';
  };

  const position = (id: string | number | undefined) => {
    // Silence beats invention: with no list we cannot know the length, and
    // announcing "1 of 1" for an eight-item list is worse than saying nothing.
    if (!items || id == null) return '';
    const i = items.indexOf(String(id));
    return i < 0 ? '' : `, position ${i + 1} of ${items.length}`;
  };

  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}${position(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${name(active.id)} is over ${name(over.id)}${position(over.id)}.`
        : `${name(active.id)} is no longer over a drop target.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${name(active.id)} onto ${name(over.id)}${position(over.id)}.`
        : `${name(active.id)} was dropped.`,
    onDragCancel: ({ active }) =>
      `Cancelled. ${name(active.id)} returned to its original position.`,
  };
}
