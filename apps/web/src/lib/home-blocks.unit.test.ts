import { describe, expect, it } from 'vitest';
import { reviewState, reviewTitle, showAutomationRuns } from './home-blocks';

describe('showAutomationRuns (ticket #1274)', () => {
  it('hides runs when the workspace has no agents (no agents database is the same: not an error)', () => {
    expect(showAutomationRuns({ loading: false, error: false, agentCount: 0 })).toBe(false);
  });
  it('shows runs as soon as one agent exists, even with no runs yet', () => {
    expect(showAutomationRuns({ loading: false, error: false, agentCount: 1 })).toBe(true);
  });
  it('does not claim either way while the agents are loading or failed to load', () => {
    expect(showAutomationRuns({ loading: true, error: false, agentCount: 3 })).toBe(false);
    expect(showAutomationRuns({ loading: false, error: true, agentCount: 3 })).toBe(false);
  });
});

describe('reviewState (ticket #1274)', () => {
  it('is none only when the list loaded and is empty', () => {
    expect(reviewState({ isPending: false, isError: false, data: [] })).toEqual({ kind: 'none' });
  });
  it('counts pending approvals', () => {
    const s = reviewState({ isPending: false, isError: false, data: [{}, {}] });
    expect(s).toEqual({ kind: 'some', count: 2 });
    expect(reviewTitle(s)).toBe('Review · 2');
  });
  it('is unknown, never zero, while loading or after a failure', () => {
    expect(reviewState({ isPending: true, isError: false, data: undefined })).toEqual({ kind: 'unknown' });
    expect(reviewState({ isPending: false, isError: true, data: undefined })).toEqual({ kind: 'unknown' });
    expect(reviewState({ isPending: false, isError: true, data: [] })).toEqual({ kind: 'unknown' });
  });
  it('titles stay plain when nothing waits', () => {
    expect(reviewTitle({ kind: 'none' })).toBe('Review');
    expect(reviewTitle({ kind: 'unknown' })).toBe('Review');
  });
});

describe('the home page does not gate the blocks (ticket #1274)', () => {
  it('renders WorkspaceHomeBlocks unconditionally, with no established-workspace predicate left', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync(new URL('../app/w/[ws]/page.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/<WorkspaceHomeBlocks/);
    expect(page).not.toMatch(/&&\s*<WorkspaceHomeBlocks/);
    expect(page).not.toMatch(/isEstablishedWorkspace/);
  });
});
