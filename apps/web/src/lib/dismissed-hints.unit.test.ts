import { describe, expect, it } from 'vitest';
import { withHint } from './dismissed-hints';

describe('#976 withHint', () => {
  it('adds a dismissal at the end and removes it in place', () => {
    expect(withHint(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(withHint(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
  });

  it('is idempotent and returns the SAME list when nothing changes, so no save fires', () => {
    const list = ['a'];
    expect(withHint(list, 'a', true)).toBe(list);
    expect(withHint(list, 'z', false)).toBe(list);
  });
});
