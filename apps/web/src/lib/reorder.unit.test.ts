import { describe, expect, it } from 'vitest';
import { computeReorder, fieldReorderMoves } from './reorder';

const list = (...ids: string[]) => ids.map((id, position) => ({ id, position }));

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
  // A realistic field list: frozen system prefix, then user fields.
  const fields = [
    { id: 'f_id', isSystem: true },
    { id: 'f_title', isSystem: true },
    { id: 'f_created', isSystem: true },
    { id: 'status', isSystem: false },
    { id: 'priority', isSystem: false },
    { id: 'assignee', isSystem: false },
  ];

  it('never writes system fields, and positions are full-list indices', () => {
    // Drag "assignee" (5) before "status" (3).
    const moves = fieldReorderMoves(fields, 'assignee', 'status');
    expect(moves.every((m) => !m.fieldId.startsWith('f_'))).toBe(true);
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
