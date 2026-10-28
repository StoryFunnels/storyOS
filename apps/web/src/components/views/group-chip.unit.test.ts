import { describe, expect, it } from 'vitest';
import { showsGroupChip } from './group-chip';

/** #1114 — which views carry the toolbar's Group chip. */
describe('showsGroupChip', () => {
  it('a board always, a list always — grouped or not', () => {
    expect(showsGroupChip('board')).toBe(true);
    expect(showsGroupChip('list')).toBe(true);
  });
  it('no other view type', () => {
    for (const t of ['table', 'gallery', 'feed', 'calendar', 'timeline', 'form', 'dashboard', undefined]) expect(showsGroupChip(t)).toBe(false);
  });
});
