import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG } from './use-view-state';
import type { ViewSummary } from './use-view-state';
import { reorderPinned, stripViews, switcherGroups, viewSources, withPin } from './pinned-tabs';

const v = (id: string, name: string, extra: Partial<ViewSummary> = {}): ViewSummary => ({
  id,
  name,
  type: 'table',
  config: EMPTY_CONFIG,
  ...extra,
});
const views = [
  v('a', 'All', { isDefault: true }),
  v('b', 'Board', { type: 'board' }),
  v('c', 'Calendar'),
  v('p', 'Mine', { ownerUserId: 'u1' }),
];
const ids = (t: ReturnType<typeof stripViews>) => t.map((x) => x.view.id);

describe('#966 stripViews: the tabs are what THIS viewer pinned', () => {
  it("draws the pinned shared views in the viewer's own order, not the database's", () => {
    expect(ids(stripViews(views, ['c', 'a'], 'a'))).toEqual(['c', 'a']);
  });

  it('adds the active view at the end when it is not pinned, flagged unpinned, so the strip shows where you are', () => {
    const out = stripViews(views, ['a'], 'b');
    expect(ids(out)).toEqual(['a', 'b']);
    expect(out.map((t) => t.pinned)).toEqual([true, false]);
  });

  it('never grows on its own: an unpinned, inactive view is not drawn', () => {
    expect(ids(stripViews(views, ['a'], 'a'))).toEqual(['a']);
  });

  it('never draws a personal view, pinned or active (those live in the sidebar)', () => {
    expect(ids(stripViews(views, ['p', 'a'], 'p'))).toEqual(['a']);
  });

  it('skips a pinned id that no longer exists', () => {
    expect(ids(stripViews(views, ['gone', 'b'], 'b'))).toEqual(['b']);
  });

  it('with nothing pinned (the API\'s "never set" and "pinned none" are the same []), shows the default view, never an empty strip', () => {
    expect(ids(stripViews(views, [], undefined))).toEqual(['a']);
    expect(ids(stripViews([v('x', 'X'), v('y', 'Y')], [], undefined))).toEqual(['x']);
  });
});

describe('#966 pin edits', () => {
  it('pins at the end and unpins in place', () => {
    expect(withPin(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(withPin(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
  });

  it('is idempotent and returns the SAME list when nothing changes (so no save fires)', () => {
    const list = ['a', 'b'];
    expect(withPin(list, 'a', true)).toBe(list);
    expect(withPin(list, 'z', false)).toBe(list);
  });

  it('a drag reorders only the pinned tabs, and keeps ids the strip does not draw at the end', () => {
    expect(reorderPinned(['a', 'b', 'c', 'p'], ['a', 'b', 'c'], 'c', 'a')).toEqual([
      'c',
      'a',
      'b',
      'p',
    ]);
    expect(reorderPinned(['a', 'b'], ['a', 'b'], 'a', 'a')).toBeNull();
    expect(reorderPinned(['a', 'b'], ['a', 'b'], 'x', 'a')).toBeNull();
  });
});

describe('#966 switcher', () => {
  const sources = (x: ViewSummary) => (x.id === 'c' ? ['Tasks', 'Clients'] : ['Tasks']);

  it("lists every SHARED view under All, and the pinned ones in the viewer's order under Pinned", () => {
    const g = switcherGroups(views, ['c', 'a'], '', sources);
    expect(g.pinned.map((x) => x.id)).toEqual(['c', 'a']);
    expect(g.all.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it("searches by view name or by a source's name", () => {
    expect(switcherGroups(views, [], 'board', sources).all.map((x) => x.id)).toEqual(['b']);
    expect(switcherGroups(views, [], 'clients', sources).all.map((x) => x.id)).toEqual(['c']);
    expect(switcherGroups(views, ['a'], 'zzz', sources)).toEqual({ pinned: [], all: [] });
  });

  it("names a dashboard's other databases as sources, once each, and an ordinary view only its own", () => {
    const dash = v('d', 'KPIs', {
      type: 'dashboard',
      config: {
        ...EMPTY_CONFIG,
        dashboard_tiles: [
          { id: '1', label: 'x', op: 'count', database_id: 'db2' },
          { id: '2', label: 'y', op: 'count', database_id: 'db2' },
          { id: '3', label: 'z', op: 'count', database_id: 'db1' },
        ],
      },
    });
    const name = (id: string) => ({ db1: 'Tasks', db2: 'Clients' })[id];
    expect(viewSources(dash, 'Tasks', 'db1', name)).toEqual(['Tasks', 'Clients']);
    expect(viewSources(v('t', 'T'), 'Tasks', 'db1', name)).toEqual(['Tasks']);
  });
});
