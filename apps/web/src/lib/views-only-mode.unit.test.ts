import { describe, expect, it } from 'vitest';
import { isViewsOnly } from './views-only-mode';

describe('isViewsOnly', () => {
  it('is per workspace and tolerates a list that has not loaded', () => {
    expect(isViewsOnly(['ws-1'], 'ws-1')).toBe(true);
    expect(isViewsOnly(['ws-1'], 'ws-2')).toBe(false);
    expect(isViewsOnly(undefined, 'ws-1')).toBe(false);
  });
});
