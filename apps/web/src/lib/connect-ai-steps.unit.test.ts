import { describe, expect, it } from 'vitest';
import { CONNECTOR_NAME, CONNECT_CLIENTS, TRY_ASKING, stepText, type ConnectClient } from './connect-ai-steps';

const clients = Object.keys(CONNECT_CLIENTS) as ConnectClient[];

describe('Connect your AI steps (#1003)', () => {
  it('offers Claude and ChatGPT: the other clients are ticket #988', () => {
    expect(clients).toEqual(['claude', 'chatgpt']);
  });

  it.each(clients)('%s: ONE set — the name step comes before the address step, each exactly once', (c) => {
    const steps = CONNECT_CLIENTS[c].steps('JCM Agency');
    const blocks = steps.map((s) => s.block).filter(Boolean);
    expect(blocks).toEqual(['name', 'addr']);
  });

  it.each(clients)('%s: names the person’s own workspace, not a placeholder', (c) => {
    const last = stepText(CONNECT_CLIENTS[c].steps('JCM Agency').at(-1)!);
    expect(last).toContain('JCM Agency');
  });

  it.each(clients)('%s: hosted StoryOS is OAuth, so no step asks for a token', (c) => {
    for (const s of CONNECT_CLIENTS[c].steps('W')) expect(stepText(s)).not.toMatch(/token|mn_pat/i);
  });

  it('the connector name is StoryOS', () => {
    expect(CONNECTOR_NAME).toBe('StoryOS');
  });
});

describe('the "Try asking it" examples are a customer\'s, not ours (#1057)', () => {
  it('there are three, and they are distinct', () => {
    expect(TRY_ASKING).toHaveLength(3);
    expect(new Set(TRY_ASKING).size).toBe(3);
  });

  it.each(TRY_ASKING)('%s names no database, person, customer or ticket of ours', (q) => {
    expect(q).not.toMatch(/\b(Issues|ticket|caret|sidebar|bugs?|Acme|Iris|Marek|Vera|Otto|Dara|Illia)\b/i);
  });
});
