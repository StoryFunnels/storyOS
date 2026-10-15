import { describe, expect, it } from 'vitest';
import { computeReorder, fieldReorderMoves } from './reorder';

const list = (...ids: string[]) => ids.map((id, position) => ({ id, position }));

/**
 * #926 — the view tabs saved the wrong order once a database's view positions had gaps (a view had been
 * deleted). Reproduced in a browser: positions [0,3,5,7,9], drag the last tab to the third slot; the stored
 * result tied two views and put the dragged one before a view it should follow. These apply the returned
 * writes to the stored positions and read the resulting order, which is what the API does.
 */
function applied(items: Array<{ id: string; position: number }>, moves: Array<{ id: string; position: number }>) {
  const next = new Map(items.map((i) => [i.id, i.position]));
  for (const m of moves) next.set(m.id, m.position);
  return {
    order: [...next.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
    ties: new Set(next.values()).size !== next.size,
  };
}

describe('computeReorder with gaps in the stored positions (#926)', () => {
  const gapped = [
    { id: 'all', position: 0 },
    { id: 'cal', position: 3 },
    { id: 'gal', position: 5 },
    { id: 'feed', position: 7 },
    { id: 'list', position: 9 },
  ];

  it('dragging the last item to the third slot lands it there, with no ties', () => {
    const r = applied(gapped, computeReorder(gapped, 'list', 'gal'));
    expect(r.order).toEqual(['all', 'cal', 'list', 'gal', 'feed']);
    expect(r.ties).toBe(false);
  });

  it('every drag between any two slots saves exactly the order dropped, without ties', () => {
    for (const a of gapped) {
      for (const b of gapped) {
        if (a.id === b.id) continue;
        const ids = gapped.map((g) => g.id);
        const from = ids.indexOf(a.id);
        const to = ids.indexOf(b.id);
        const expected = [...ids];
        expected.splice(to, 0, expected.splice(from, 1)[0]!);
        const r = applied(gapped, computeReorder(gapped, a.id, b.id));
        expect(r.order, `${a.id} -> ${b.id}`).toEqual(expected);
        expect(r.ties, `${a.id} -> ${b.id}`).toBe(false);
      }
    }
  });

  it('items already stored at their new index are not rewritten', () => {
    const contiguous = [{ id: 'a', position: 0 }, { id: 'b', position: 1 }, { id: 'c', position: 2 }];
    expect(computeReorder(contiguous, 'a', 'b')).toEqual([{ id: 'b', position: 0 }, { id: 'a', position: 1 }]);
  });

  it('items with no numeric position keep the old id-at-index behaviour', () => {
    expect(computeReorder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a', 'b')).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
  });
});

describe('computeReorder', () => {
  it('returns no writes when dropped on itself', () => {
    expect(computeReorder(list('a', 'b', 'c'), 'a', 'a')).toEqual([]);
  });

  it('returns no writes when active or over is unknown', () => {
    expect(computeReorder(list('a', 'b'), 'a', 'zzz')).toEqual([]);
    expect(computeReorder(list('a', 'b'), 'zzz', 'b')).toEqual([]);
  });

  it('shifts every item between source and target (not just a 2-item swap)', () => {
    // Drag "a" (0) onto "d" (3): b,c,d each slide left by one, a lands at 3.
    const moves = computeReorder(list('a', 'b', 'c', 'd'), 'a', 'd');
    expect(moves).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'd', position: 2 },
      { id: 'a', position: 3 },
    ]);
  });

  it('handles dragging a later item earlier', () => {
    const moves = computeReorder(list('a', 'b', 'c', 'd'), 'd', 'b');
    expect(moves).toEqual([
      { id: 'd', position: 1 },
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
    ]);
  });

  it('only writes items whose index actually changed', () => {
    // Adjacent swap: only the two neighbours move.
    const moves = computeReorder(list('a', 'b', 'c'), 'a', 'b');
    expect(moves).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
  });

  it('produces a contiguous 0..n-1 order for the moved run', () => {
    const items = list('a', 'b', 'c', 'd', 'e');
    const moves = computeReorder(items, 'b', 'e');
    // Apply the writes back onto the list and confirm the final order.
    const positions = new Map(items.map((i) => [i.id, i.position]));
    for (const m of moves) positions.set(m.id, m.position);
    const finalOrder = [...positions.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(finalOrder).toEqual(['a', 'c', 'd', 'e', 'b']);
  });
});

describe('fieldReorderMoves', () => {
  // A realistic field list: frozen system prefix, then user fields. Note the
  // title carries isSystem:false but type:'title' (the real schema, #76) — it
  // must still be excluded from position writes via the type guard.
  const fields = [
    { id: 'f_id', isSystem: true, type: 'id' },
    { id: 'f_title', isSystem: false, type: 'title' },
    { id: 'f_created', isSystem: true, type: 'created_at' },
    { id: 'status', isSystem: false, type: 'select' },
    { id: 'priority', isSystem: false, type: 'select' },
    { id: 'assignee', isSystem: false, type: 'user' },
  ];

  it('never writes system or title fields, and positions are full-list indices', () => {
    // Drag "assignee" (5) before "status" (3).
    const moves = fieldReorderMoves(fields, 'assignee', 'status');
    expect(moves.every((m) => !m.fieldId.startsWith('f_'))).toBe(true);
    // #76: the title field (isSystem:false, type:title) is never emitted.
    expect(moves.some((m) => m.fieldId === 'f_title')).toBe(false);
    // Resulting user order: assignee, status, priority — at full indices 3,4,5.
    expect(moves).toEqual([
      { fieldId: 'assignee', position: 3 },
      { fieldId: 'status', position: 4 },
      { fieldId: 'priority', position: 5 },
    ]);
  });

  it('keeps user fields after the frozen system prefix', () => {
    const moves = fieldReorderMoves(fields, 'status', 'assignee');
    // Lowest emitted position stays >= the number of system fields (3).
    expect(Math.min(...moves.map((m) => m.position))).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for a no-op drop', () => {
    expect(fieldReorderMoves(fields, 'status', 'status')).toEqual([]);
  });
});
