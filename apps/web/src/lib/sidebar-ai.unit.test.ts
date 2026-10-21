import { describe, expect, it } from 'vitest';
import { APPROVALS_LIST_LIMIT, goldCountLabel } from './sidebar-ai';

describe('goldCountLabel (#967)', () => {
  it('shows nothing for zero, negative or NaN: a gold 0 is noise, and a made-up number is worse', () => {
    expect(goldCountLabel(0)).toBeNull();
    expect(goldCountLabel(-1)).toBeNull();
    expect(goldCountLabel(Number.NaN)).toBeNull();
  });
  it('prints the real number below any cap', () => {
    expect(goldCountLabel(3)).toBe('3');
    expect(goldCountLabel(99, APPROVALS_LIST_LIMIT)).toBe('99');
  });
  it('says "at least" when a capped list reaches its cap, never the cap bare', () => {
    expect(goldCountLabel(APPROVALS_LIST_LIMIT, APPROVALS_LIST_LIMIT)).toBe('100+');
    expect(goldCountLabel(250, APPROVALS_LIST_LIMIT)).toBe('100+');
  });
  it('an uncapped count has no plus', () => {
    expect(goldCountLabel(1000)).toBe('1000');
  });
});
