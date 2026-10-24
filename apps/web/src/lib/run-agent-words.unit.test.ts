import { describe, expect, it } from 'vitest';
import { agentModeOf, agentNote, scheduleScopeNote } from './run-agent-words';

describe('what the editor says about running an agent (ticket #1056)', () => {
  it('reads the AI mode label; unset or unknown is non-AI, what every agent has always been', () => {
    expect(agentModeOf('Non-AI')).toBe('non_ai');
    expect(agentModeOf('Your own AI')).toBe('your_own_ai');
    expect(agentModeOf('StoryOS AI')).toBe('storyos_ai');
    expect(agentModeOf(null)).toBe('non_ai');
    expect(agentModeOf('something new')).toBe('non_ai');
  });

  it('own-AI says it only works while the client is connected; StoryOS-AI says credits; non-AI says nobody needs to be signed in', () => {
    expect(agentNote({ enabled: true, mode: 'your_own_ai' }).text).toMatch(/only does its work while your AI client is connected/);
    expect(agentNote({ enabled: true, mode: 'storyos_ai' }).text).toMatch(/uses credits every time it runs/);
    expect(agentNote({ enabled: true, mode: 'non_ai' }).text).toMatch(/even when nobody is signed in/);
  });

  it('a switched-off agent is a warning, whatever its mode: the rule would fail', () => {
    for (const mode of ['non_ai', 'your_own_ai', 'storyos_ai'] as const) {
      const n = agentNote({ enabled: false, mode });
      expect(n.tone).toBe('warn');
      expect(n.text).toMatch(/switched off/);
    }
  });

  it('only a scheduled rule gets the once-per-record sentence, and a scheduled rule with no filter is warned', () => {
    expect(scheduleScopeNote({ triggerType: 'record_created', hasFilter: false })).toBeNull();
    expect(scheduleScopeNote({ triggerType: 'schedule', hasFilter: true })).toMatchObject({ tone: 'plain' });
    const none = scheduleScopeNote({ triggerType: 'schedule', hasFilter: false })!;
    expect(none.tone).toBe('warn');
    expect(none.text).toMatch(/every record in this database/);
  });
});
