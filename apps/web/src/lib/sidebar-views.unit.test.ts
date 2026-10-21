import { describe, expect, it } from 'vitest';
import { autoExpandedKey, databaseRowActive, databaseViewsExpandedKey, shouldAutoExpand, visibleChildViews } from './sidebar-views';

const views = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

describe('visibleChildViews (#931, #993)', () => {
  it('expanded shows every view, in the caller\'s order', () => {
    expect(visibleChildViews(views, { expanded: true }).map((v) => v.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('collapsed shows NONE — the active view included, so the caret never lies (#993)', () => {
    expect(visibleChildViews(views, { expanded: false })).toEqual([]);
  });

  it('does not mutate its input', () => {
    const copy = [...views];
    visibleChildViews(views, { expanded: true });
    expect(views).toEqual(copy);
  });
});

describe('databaseRowActive (#993): one "you are here" highlight, never none, never two', () => {
  it('collapsed with the active view inside: the DATABASE row carries it', () => {
    expect(databaseRowActive({ isHere: true, expanded: false, activeViewShown: false })).toBe(true);
  });
  it('expanded with the active view showing: the VIEW row carries it, not the database row', () => {
    expect(databaseRowActive({ isHere: true, expanded: true, activeViewShown: true })).toBe(false);
  });
  it('expanded but on a record page (no active view row): the database row keeps it', () => {
    expect(databaseRowActive({ isHere: true, expanded: true, activeViewShown: false })).toBe(true);
  });
  it('elsewhere in the app: never', () => {
    for (const expanded of [true, false]) expect(databaseRowActive({ isHere: false, expanded, activeViewShown: false })).toBe(false);
  });
});

describe('shouldAutoExpand (#993): open ONCE per view, then the person\'s collapse wins', () => {
  it('opens when landing on a view it has not opened for', () => {
    expect(shouldAutoExpand('v1', null)).toBe(true);
    expect(shouldAutoExpand('v2', 'v1')).toBe(true);
  });
  it('does not open again for the same view — a collapse after landing stays collapsed', () => {
    expect(shouldAutoExpand('v1', 'v1')).toBe(false);
  });
  it('never opens when there is no active view (another page, or the database\'s default view)', () => {
    expect(shouldAutoExpand(null, null)).toBe(false);
    expect(shouldAutoExpand(null, 'v1')).toBe(false);
  });
  it('keys its memory by workspace AND database, per session', () => {
    expect(autoExpandedKey('w1', 'd1')).not.toBe(autoExpandedKey('w1', 'd2'));
    expect(autoExpandedKey('w1', 'd1')).not.toBe(databaseViewsExpandedKey('w1', 'd1'));
  });
});

describe('databaseViewsExpandedKey', () => {
  it('is scoped to workspace AND database, so two databases never share a toggle', () => {
    expect(databaseViewsExpandedKey('w1', 'd1')).not.toBe(databaseViewsExpandedKey('w1', 'd2'));
    expect(databaseViewsExpandedKey('w1', 'd1')).not.toBe(databaseViewsExpandedKey('w2', 'd1'));
  });
});
