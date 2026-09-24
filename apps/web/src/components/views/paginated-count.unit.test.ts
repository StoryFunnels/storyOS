import { describe, expect, it } from 'vitest';
import { groupCountLabel } from './paginated-count';

describe('groupCountLabel — #755: a paginated group/column count is never shown as a bare, unqualified number while more pages remain unloaded', () => {
  it('qualifies the count while more pages remain', () => {
    expect(groupCountLabel(4, true)).toBe('4 loaded');
  });

  it('shows a plain count once the set is fully loaded — withholding a TRUE number is its own defect (AC2/AC5)', () => {
    expect(groupCountLabel(4, false)).toBe('4');
  });

  it('qualifies zero the same way — a confident 0 is the most dangerous wrong number', () => {
    expect(groupCountLabel(0, true)).toBe('0 loaded');
  });

  it('measured case from storyos/issues: 4 loaded reads honestly instead of implying the group holds exactly 4', () => {
    // The ticket's own measurement: header said 4, the group actually held 63.
    expect(groupCountLabel(4, true)).not.toBe('63');
    expect(groupCountLabel(4, true)).toBe('4 loaded');
  });
});
