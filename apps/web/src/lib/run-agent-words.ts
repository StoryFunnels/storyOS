/**
 * Ticket #1056 — what the automation editor says about an agent a rule is about to run, in plain words. Pure so the promises it
 * makes can be tested: each sentence is tied to what the server actually does for that agent's "AI mode"
 * (agent-runtime.ts: non_ai runs by itself, your_own_ai needs the person's MCP client, storyos_ai is metered).
 */
export type AgentMode = 'non_ai' | 'your_own_ai' | 'storyos_ai';

/** The agent's "AI mode" select LABEL → the mode. Unset (or a label this does not know) is what every agent has always been: non-AI. */
export function agentModeOf(label: string | null | undefined): AgentMode {
  if (label === 'Your own AI') return 'your_own_ai';
  if (label === 'StoryOS AI') return 'storyos_ai';
  return 'non_ai';
}

export interface AgentNote {
  tone: 'plain' | 'warn';
  text: string;
}

export function agentNote(input: { enabled: boolean; mode: AgentMode }): AgentNote {
  if (!input.enabled) {
    return { tone: 'warn', text: 'This agent is switched off. A rule that runs it will fail until you switch it on.' };
  }
  switch (input.mode) {
    case 'your_own_ai':
      return {
        tone: 'warn',
        text: 'This agent works through your own AI, so it only does its work while your AI client is connected to StoryOS. Overnight, nothing runs unless that client is open and connected.',
      };
    case 'storyos_ai':
      return { tone: 'plain', text: 'This agent runs on StoryOS AI and uses credits every time it runs.' };
    default:
      return { tone: 'plain', text: 'This agent does not use AI. It runs by itself, even when nobody is signed in.' };
  }
}

/** A scheduled rule runs its actions once per MATCHING record (up to 500 a tick), so an agent on it runs once per record. Say so. */
export function scheduleScopeNote(input: { triggerType: string; hasFilter: boolean }): AgentNote | null {
  if (input.triggerType !== 'schedule') return null;
  return input.hasFilter
    ? { tone: 'plain', text: 'On a schedule, this runs the agent once for each record the rule’s filter matches.' }
    : {
        tone: 'warn',
        text: 'This rule has no filter, so on a schedule it would run the agent once for every record in this database (up to 500 each time). Add a filter above to narrow it.',
      };
}
