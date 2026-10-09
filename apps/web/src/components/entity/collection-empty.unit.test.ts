import { describe, expect, it } from 'vitest';
import { collectionControlsVisible } from './collection-empty';

describe('collectionControlsVisible (#642 item 3)', () => {
  it('hides the controls when the relation has no links and nothing is configured', () => {
    expect(collectionControlsVisible({ linkedCount: 0, filtersActive: false })).toBe(false);
  });
  it('shows them as soon as there is something to narrow', () => {
    expect(collectionControlsVisible({ linkedCount: 1, filtersActive: false })).toBe(true);
    expect(collectionControlsVisible({ linkedCount: 40, filtersActive: false })).toBe(true);
  });
  it('KEEPS them when a filter narrows a populated relation to zero visible rows — the dead end this rule must not create', () => {
    // The visible row count is deliberately not an input: that is the whole point.
    expect(collectionControlsVisible({ linkedCount: 12, filtersActive: true })).toBe(true);
  });
  it('keeps them when a filter or sort is active but the relation has no links, so it can still be cleared', () => {
    expect(collectionControlsVisible({ linkedCount: 0, filtersActive: true })).toBe(true);
  });
});
