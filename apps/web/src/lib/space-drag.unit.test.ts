import { describe, expect, it } from 'vitest';
import { dropEdge, dropGroupId, holdUnderPointer } from './space-drag';

/** Ticket #1346 — the drop line's side and the group a drop would join. */
describe('#1346 dropEdge', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('dragging DOWN lands after the target: the line is on its bottom edge', () => {
    expect(dropEdge(order, 'a', 'c')).toBe('bottom');
    expect(dropEdge(order, 'a', 'b')).toBe('bottom');
  });
  it('dragging UP lands before the target: the line is on its top edge', () => {
    expect(dropEdge(order, 'd', 'b')).toBe('top');
    expect(dropEdge(order, 'c', 'b')).toBe('top');
  });
  it('an id the list does not hold falls back to top rather than guessing', () => {
    expect(dropEdge(order, 'zzz', 'b')).toBe('top');
    expect(dropEdge(order, 'a', 'zzz')).toBe('top');
  });
});

describe('#1346 dropGroupId', () => {
  const spaces = [
    { id: 's1', groupId: 'g1' },
    { id: 's2', groupId: null },
    { id: 's3' },
  ];
  it('a group header target names that group', () => {
    expect(dropGroupId('group:g9', spaces)).toBe('g9');
  });
  it('a grouped space target names its group (dropping beside it joins it)', () => {
    expect(dropGroupId('s1', spaces)).toBe('g1');
  });
  it('ungrouped targets, the ungrouped zone and no target name no group', () => {
    expect(dropGroupId('s2', spaces)).toBeNull();
    expect(dropGroupId('s3', spaces)).toBeNull();
    expect(dropGroupId('ungrouped', spaces)).toBeNull();
    expect(dropGroupId(null, spaces)).toBeNull();
    expect(dropGroupId('unknown', spaces)).toBeNull();
  });
});

describe('#1346 holdUnderPointer', () => {
  const t = { x: 5, y: 40, scaleX: 1, scaleY: 1 };
  it('adds how far the fold moved the header, so the preview stays under the pointer', () => {
    // grabbed at 564, measured at 342 after the fold: the preview must sit 222px lower than the raw delta puts it
    expect(holdUnderPointer({ activeNodeRect: { top: 342 }, transform: t }, 564)).toEqual({ ...t, y: 40 + 222 });
  });
  it('is the identity when the header did not move, and leaves x alone', () => {
    expect(holdUnderPointer({ activeNodeRect: { top: 100 }, transform: t }, 100)).toEqual(t);
  });
  it('is the identity when either measurement is missing rather than inventing a correction', () => {
    expect(holdUnderPointer({ activeNodeRect: { top: 1 }, transform: t }, null)).toEqual(t);
    expect(holdUnderPointer({ activeNodeRect: null, transform: t }, 5)).toEqual(t);
  });
});
