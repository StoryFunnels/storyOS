import { describe, expect, it } from 'vitest';
import { diffSnapshots } from './record-diff';

describe('diffSnapshots', () => {
  it('returns nothing when both snapshots are identical', () => {
    const snap = { values: { a: 1, b: 'x' }, title: 'Same' };
    expect(diffSnapshots(snap, { ...snap, values: { ...snap.values } })).toEqual({});
  });

  it('reports a changed field value', () => {
    const before = { values: { a: 1 }, title: 'T' };
    const after = { values: { a: 2 }, title: 'T' };
    expect(diffSnapshots(before, after)).toEqual({ a: { from: 1, to: 2 } });
  });

  it('reports a field added in `after` (missing in `before`)', () => {
    const before = { values: {}, title: 'T' };
    const after = { values: { a: 'new' }, title: 'T' };
    expect(diffSnapshots(before, after)).toEqual({ a: { from: null, to: 'new' } });
  });

  it('reports a field removed in `after` (present only in `before`)', () => {
    const before = { values: { a: 'old' }, title: 'T' };
    const after = { values: {}, title: 'T' };
    expect(diffSnapshots(before, after)).toEqual({ a: { from: 'old', to: null } });
  });

  it('treats an explicit null the same as an absent key', () => {
    const before = { values: { a: null }, title: 'T' };
    const after = { values: {}, title: 'T' };
    expect(diffSnapshots(before, after)).toEqual({});
  });

  it('reports a title change under the "title" key', () => {
    const before = { values: {}, title: 'Old title' };
    const after = { values: {}, title: 'New title' };
    expect(diffSnapshots(before, after)).toEqual({ title: { from: 'Old title', to: 'New title' } });
  });

  it('deep-compares array and object field values (order-sensitive)', () => {
    const before = { values: { tags: ['a', 'b'] }, title: 'T' };
    const same = { values: { tags: ['a', 'b'] }, title: 'T' };
    const reordered = { values: { tags: ['b', 'a'] }, title: 'T' };
    expect(diffSnapshots(before, same)).toEqual({});
    expect(diffSnapshots(before, reordered)).toEqual({
      tags: { from: ['a', 'b'], to: ['b', 'a'] },
    });
  });

  it('combines multiple changed fields and a title change in one diff', () => {
    const before = { values: { a: 1, b: 2, c: 3 }, title: 'Old' };
    const after = { values: { a: 1, b: 20, c: 3 }, title: 'New' };
    expect(diffSnapshots(before, after)).toEqual({
      b: { from: 2, to: 20 },
      title: { from: 'Old', to: 'New' },
    });
  });
});
