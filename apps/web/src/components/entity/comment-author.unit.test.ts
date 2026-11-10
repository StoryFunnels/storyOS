import { describe, expect, it } from 'vitest';
import { commentAuthorView } from './comment-author';

const author = { id: 'u1', name: 'Ievgen', image: null };

describe('commentAuthorView (ticket #1214 AC4)', () => {
  it('shows the agent for an agent comment with a name', () => {
    expect(commentAuthorView({ author, source: 'agent', agent_name: 'Onboarding Assistant' })).toEqual({
      kind: 'agent',
      name: 'Onboarding Assistant',
    });
  });
  it('falls back to the manager when the agent has no name, never blank or "undefined"', () => {
    for (const agent_name of [null, '', '   ']) {
      const v = commentAuthorView({ author, source: 'agent', agent_name });
      expect(v).toMatchObject({ kind: 'person', name: 'Ievgen' });
    }
  });
  it('keeps the person for human, mcp, automation and null sources even if agent_name is set', () => {
    for (const source of ['human', 'mcp', 'automation', null] as const) {
      expect(commentAuthorView({ author, source, agent_name: 'Stale' })).toMatchObject({
        kind: 'person',
        name: 'Ievgen',
        userId: 'u1',
      });
    }
  });
  it('never yields a blank name when the person name is blank', () => {
    expect(commentAuthorView({ author: { ...author, name: '' }, source: null, agent_name: null }).name).toBe('Unknown');
  });
});
