import { describe, expect, it } from 'vitest';
import { choiceDirectionLabels, reorderedIds } from './option-order';

describe('reorderedIds (#963)', () => {
  it('returns the whole new order, not a diff', () => {
    expect(reorderedIds(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderedIds(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('dropping on the same slot, or out of range, sends nothing', () => {
    expect(reorderedIds(['a', 'b'], 1, 1)).toBeNull();
    expect(reorderedIds(['a', 'b'], -1, 1)).toBeNull();
    expect(reorderedIds(['a', 'b'], 0, 5)).toBeNull();
  });

  it('does not mutate its input', () => {
    const ids = ['a', 'b', 'c'];
    reorderedIds(ids, 0, 2);
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
