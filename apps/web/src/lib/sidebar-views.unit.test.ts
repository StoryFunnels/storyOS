import { describe, expect, it } from 'vitest';
import { databaseViewsExpandedKey, visibleChildViews } from './sidebar-views';

const views = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

describe('visibleChildViews (#931)', () => {
  it('expanded shows every view, in the caller\'s order', () => {
    expect(visibleChildViews(views, { expanded: true, activeViewId: null }).map((v) => v.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('collapsed with nothing active or pinned shows none', () => {
    expect(visibleChildViews(views, { expanded: false, activeViewId: null })).toEqual([]);
  });

  it('collapsed KEEPS the active view, so you never lose the view you are on', () => {
    expect(visibleChildViews(views, { expanded: false, activeViewId: 'c' }).map((v) => v.id)).toEqual(['c']);
  });

  it('collapsed KEEPS pinned views too, and the active one, without re-sorting', () => {
    const out = visibleChildViews(views, { expanded: false, activeViewId: 'd', pinnedIds: new Set(['b', 'd']) });
    expect(out.map((v) => v.id)).toEqual(['b', 'd']);
  });

  it('an active id that is not one of these views hides nothing it should show and invents nothing', () => {
    expect(visibleChildViews(views, { expanded: false, activeViewId: 'zzz' })).toEqual([]);
  });

  it('does not mutate its input', () => {
    const copy = [...views];
    visibleChildViews(views, { expanded: true, activeViewId: null });
    expect(views).toEqual(copy);
  });
});

describe('databaseViewsExpandedKey', () => {
  it('is scoped to workspace AND database, so two databases never share a toggle', () => {
    expect(databaseViewsExpandedKey('w1', 'd1')).not.toBe(databaseViewsExpandedKey('w1', 'd2'));
    expect(databaseViewsExpandedKey('w1', 'd1')).not.toBe(databaseViewsExpandedKey('w2', 'd1'));
  });
});
