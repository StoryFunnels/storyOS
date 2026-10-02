import { describe, expect, it } from 'vitest';
import { isViewsOnly, withViewsOnly } from './views-only-mode';

describe('isViewsOnly', () => {
  it('is per workspace and tolerates a list that has not loaded', () => {
    expect(isViewsOnly(['ws-1'], 'ws-1')).toBe(true);
    expect(isViewsOnly(['ws-1'], 'ws-2')).toBe(false);
    expect(isViewsOnly(undefined, 'ws-1')).toBe(false);
  });
});

describe('withViewsOnly', () => {
  it('adds a workspace without duplicating it', () => {
    expect(withViewsOnly([], 'ws-1', true)).toEqual(['ws-1']);
    expect(withViewsOnly(['ws-1'], 'ws-1', true)).toEqual(['ws-1']);
  });

  // What the filter must KEEP: switching one workspace never disturbs another.
  it('removes only the named workspace', () => {
    expect(withViewsOnly(['ws-1', 'ws-2'], 'ws-1', false)).toEqual(['ws-2']);
    expect(withViewsOnly(['ws-2'], 'ws-1', false)).toEqual(['ws-2']);
    expect(withViewsOnly(undefined, 'ws-1', false)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const list = ['ws-1'];
    withViewsOnly(list, 'ws-2', true);
    expect(list).toEqual(['ws-1']);
  });
});
