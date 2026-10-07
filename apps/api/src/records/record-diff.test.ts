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

  // #595 — rich_text fields get an additional block-level breakdown, but only
  // when the caller identifies the field id as rich_text; every other field
  // type's diff is byte-for-byte the same as before this ticket.
  describe('richTextFieldIds (#595)', () => {
    const block = (id: string, text: string) => ({
      id,
      type: 'paragraph',
      content: [{ type: 'text', text, styles: {} }],
    });

    it('does nothing extra when richTextFieldIds is omitted, even for a field holding block content', () => {
      const before = { values: { notes: [block('b1', 'Hello')] }, title: 'T' };
      const after = { values: { notes: [block('b1', 'Goodbye')] }, title: 'T' };
      expect(diffSnapshots(before, after)).toEqual({
        notes: { from: [block('b1', 'Hello')], to: [block('b1', 'Goodbye')] },
      });
    });

    it('adds a `blocks` breakdown for a field id in richTextFieldIds', () => {
      const before = { values: { notes: [block('b1', 'Hello')] }, title: 'T' };
      const after = { values: { notes: [block('b1', 'Goodbye')] }, title: 'T' };
      expect(diffSnapshots(before, after, new Set(['notes']))).toEqual({
        notes: {
          from: [block('b1', 'Hello')],
          to: [block('b1', 'Goodbye')],
          blocks: [{ kind: 'changed', blockId: 'b1', from: block('b1', 'Hello'), to: block('b1', 'Goodbye') }],
        },
      });
    });

    it('does not enrich a field NOT in richTextFieldIds, even when other fields are', () => {
      const before = { values: { notes: [block('b1', 'Hello')], count: 1 }, title: 'T' };
      const after = { values: { notes: [block('b1', 'Hello')], count: 2 }, title: 'T' };
      expect(diffSnapshots(before, after, new Set(['notes']))).toEqual({ count: { from: 1, to: 2 } });
    });

    it('leaves every other field type unenriched (MUST KEEP WORKING)', () => {
      const before = { values: { a: 1, tags: ['x'] }, title: 'Old' };
      const after = { values: { a: 2, tags: ['y'] }, title: 'New' };
      expect(diffSnapshots(before, after, new Set(['notes']))).toEqual({
        a: { from: 1, to: 2 },
        tags: { from: ['x'], to: ['y'] },
        title: { from: 'Old', to: 'New' },
      });
    });
  });
});
