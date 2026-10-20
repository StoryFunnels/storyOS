import { describe, expect, it } from 'vitest';
import { choiceDirectionLabels, reorderPositions } from './option-order';

describe('reorderPositions (#963)', () => {
  it('moving one option down writes a clean 0..n-1 sequence for exactly the options that moved', () => {
    // [a b c d] drag a to slot 2 -> [b c a d]
    expect(reorderPositions(['a', 'b', 'c', 'd'], 0, 2)).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'a', position: 2 },
    ]);
  });

  it('swapping neighbours writes only the two that changed', () => {
    expect(reorderPositions(['a', 'b', 'c'], 1, 2)).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });

  it('dropping on the same slot, or out of range, writes nothing', () => {
    expect(reorderPositions(['a', 'b'], 1, 1)).toEqual([]);
    expect(reorderPositions(['a', 'b'], -1, 1)).toEqual([]);
    expect(reorderPositions(['a', 'b'], 0, 5)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const ids = ['a', 'b', 'c'];
    reorderPositions(ids, 0, 2);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('choiceDirectionLabels (#963)', () => {
  it('names the first and last option in position order, and the reverse', () => {
    expect(choiceDirectionLabels([{ label: 'Low' }, { label: 'Medium' }, { label: 'High' }, { label: 'Urgent' }])).toEqual({
      asc: 'Low → Urgent',
      desc: 'Urgent → Low',
    });
  });

  it('has no labels when there is no order to name', () => {
    expect(choiceDirectionLabels([])).toBeNull();
    expect(choiceDirectionLabels([{ label: 'Only' }])).toBeNull();
  });
});
