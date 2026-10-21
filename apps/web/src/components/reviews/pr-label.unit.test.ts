import { describe, expect, it } from 'vitest';
import { prLabel } from './pr-label';

describe('prLabel (#968)', () => {
  it('qualifies the number with its repo', () => {
    expect(prLabel('StoryFunnels/storyOS', 1125)).toBe('StoryFunnels/storyOS PR #1125');
  });
  it('tells two repos with the same PR number apart', () => {
    expect(prLabel('StoryFunnels/storyOS', 1125)).not.toBe(prLabel('StoryFunnels/storyos-website', 1125));
  });
});
