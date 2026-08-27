import { describe, expect, it } from 'vitest';
import { blockAnnouncements } from './drag-announcements';

/**
 * #415 — every drag announced a raw uuid to screen readers.
 *
 * Read verbatim out of the live aria-live region on app.storyos.dev:
 *
 *   "Picked up draggable item 102568ca-bfdf-4ba8-88b4-cc84d46aecf1."
 *
 * Those are dnd-kit's stock strings with our sortable ids substituted in. Every
 * sortable in this app is keyed by a database / field / record uuid, so the
 * announcement was pure hex: no name, no position, no list length.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const AMOUNT = '102568ca-bfdf-4ba8-88b4-cc84d46aecf1';
const STAGE = 'a5adb79c-7c57-4671-a393-0d9cc44175c7';
const NAMES: Record<string, string> = { [AMOUNT]: 'Amount', [STAGE]: 'Stage' };

const announce = blockAnnouncements((id) => NAMES[id], [AMOUNT, STAGE]);

describe('drag announcements name the thing, never its id', () => {
  it('pick-up says the name and the position', () => {
    const said = announce.onDragStart({ active: { id: AMOUNT } } as never);
    expect(said).toContain('Amount');
    expect(said).toContain('1 of 2');
  });

  it('move-over names BOTH the item and what it is over', () => {
    const said = announce.onDragOver({ active: { id: AMOUNT }, over: { id: STAGE } } as never);
    expect(said).toContain('Amount');
    expect(said).toContain('Stage');
  });

  it('drop names both', () => {
    const said = announce.onDragEnd({ active: { id: AMOUNT }, over: { id: STAGE } } as never);
    expect(said).toContain('Amount');
    expect(said).toContain('Stage');
  });

  it('cancel says the item returned, by name', () => {
    const said = announce.onDragCancel({ active: { id: AMOUNT } } as never);
    expect(said).toContain('Amount');
    expect(said).toMatch(/original position/i);
  });

  it('NO announcement contains a uuid — the regression guard', () => {
    /*
     * The assertion that matters. A future caller that forgets to pass a real
     * labeller, or a label lookup that silently misses, must fail here rather
     * than quietly going back to reading hex aloud.
     */
    const all = [
      announce.onDragStart({ active: { id: AMOUNT } } as never),
      announce.onDragOver({ active: { id: AMOUNT }, over: { id: STAGE } } as never),
      announce.onDragEnd({ active: { id: AMOUNT }, over: { id: STAGE } } as never),
      announce.onDragCancel({ active: { id: AMOUNT } } as never),
    ];
    for (const said of all) expect(String(said)).not.toMatch(UUID);
  });

  it('an UNKNOWN id degrades to "item", never to the raw uuid', () => {
    // A label lookup can miss — a field removed mid-drag, a stale list. The
    // fallback has to be a word, because falling back to the id is the bug.
    const orphan = blockAnnouncements(() => undefined);
    const said = String(orphan.onDragStart({ active: { id: AMOUNT } } as never));
    expect(said).toContain('item');
    expect(said).not.toMatch(UUID);
  });

  it('omits the position when the list length is unknown', () => {
    // Better to say nothing than to invent "1 of 1" for a list we cannot see.
    const noItems = blockAnnouncements((id) => NAMES[id]);
    expect(String(noItems.onDragStart({ active: { id: AMOUNT } } as never))).not.toMatch(/position/);
  });
});
