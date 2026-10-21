/** "StoryFunnels/storyOS PR #1125": the repo qualifies the number, because two repos both have a #1125 (#968). */
export function prLabel(repo: string, number: number): string {
  return `${repo} PR #${number}`;
}
