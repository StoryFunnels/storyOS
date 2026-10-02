import { describe, expect, it } from 'vitest';
import { currentWorkspaceId, splitTokens, workspaceLabel } from './token-scope';

const workspaces = [
  { id: 'w-borderlands', name: 'Borderlands Group', slug: 'borderlands' },
  { id: 'w-storyos', name: 'JCM Agency', slug: 'jcm' },
];

describe('currentWorkspaceId', () => {
  it('resolves by id or slug, and is null until the list has loaded', () => {
    expect(currentWorkspaceId('w-storyos', workspaces)).toBe('w-storyos');
    expect(currentWorkspaceId('borderlands', workspaces)).toBe('w-borderlands');
    expect(currentWorkspaceId('w-storyos', undefined)).toBeNull();
    expect(currentWorkspaceId('nope', workspaces)).toBeNull();
  });
});

describe('splitTokens', () => {
  const tokens = [
    { id: 'a', workspace_id: 'w-borderlands' },
    { id: 'b', workspace_id: 'w-storyos' },
    { id: 'c', workspace_id: 'w-storyos' },
    { id: 'd', workspace_id: null },
  ];

  it('keeps only the current workspace in `here`', () => {
    const { here, elsewhere } = splitTokens(tokens, 'w-borderlands');
    expect(here.map((t) => t.id)).toEqual(['a']);
    expect(elsewhere.map((t) => t.id)).toEqual(['b', 'c', 'd']);
  });

  // What the filter must KEEP: nothing is dropped, only moved behind the toggle.
  it('loses no token', () => {
    const { here, elsewhere } = splitTokens(tokens, 'w-storyos');
    expect(here.length + elsewhere.length).toBe(tokens.length);
  });

  it('never folds a workspace-less token into the default list', () => {
    expect(splitTokens(tokens, 'w-storyos').here.map((t) => t.id)).not.toContain('d');
  });
});

describe('workspaceLabel', () => {
  it('gives a name, never the uuid', () => {
    expect(workspaceLabel('w-storyos', workspaces)).toBe('JCM Agency');
    expect(workspaceLabel('w-unknown', workspaces)).not.toContain('w-unknown');
    expect(workspaceLabel(null, workspaces)).toBe('No specific workspace');
    expect(workspaceLabel('w-storyos', undefined)).not.toContain('w-storyos');
  });
});
