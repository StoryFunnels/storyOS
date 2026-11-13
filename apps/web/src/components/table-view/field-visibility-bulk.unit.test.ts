import { describe, expect, it } from 'vitest';
import { hideAllFields, showAllFields, toggleFieldVisibility } from './number-column';

/** #1281 item 5 — "Show all" / "Hide all" in the inline Display field list. What they must KEEP matters as much as what they change. */
describe('Display field list: Show all / Hide all', () => {
  const list = ['a', 'b', 'c'];

  it('Show all removes every listed id from the hidden array', () => {
    expect(showAllFields(['a', 'c'], list)).toEqual([]);
  });

  it('Show all KEEPS a hidden id that is not in the list (another surface or a stale id owns it)', () => {
    expect(showAllFields(['a', 'zzz'], list)).toEqual(['zzz']);
  });

  it('Hide all adds every listed id once and does not duplicate one already hidden', () => {
    const next = hideAllFields(['b'], list);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
    expect(next.length).toBe(3);
  });

  it('Hide all KEEPS existing hidden ids outside the list, and never adds an id it was not given (the title is never given)', () => {
    const next = hideAllFields(['zzz'], list);
    expect(next).toContain('zzz');
    expect(next).not.toContain('title-field-id');
    expect(hideAllFields([], [])).toEqual([]);
  });

  it('Show all after Hide all returns to the starting array; a single toggle is unchanged', () => {
    expect(showAllFields(hideAllFields(['zzz'], list), list)).toEqual(['zzz']);
    expect(toggleFieldVisibility(['a'], 'a', true)).toEqual([]);
  });
});
