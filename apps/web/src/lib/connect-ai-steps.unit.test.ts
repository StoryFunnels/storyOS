import { describe, expect, it } from 'vitest';
import { CONNECTOR_NAME, CONNECT_CLIENTS, TRY_ASKING, stepText, type ConnectClient } from './connect-ai-steps';

const clients = Object.keys(CONNECT_CLIENTS) as ConnectClient[];

describe('Connect your AI steps (#1003)', () => {
  // Codex, Cursor and Gemini CLI wait until a person has followed each guide against the real client (ticket #988): a guide
  // nobody followed is a dead end, so they are not chips yet. "Other" is the honest path for any client.
  it('offers Claude, ChatGPT and Other', () => {
    expect(clients).toEqual(['claude', 'chatgpt', 'other']);
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

  const guided = clients.filter((c) => c !== 'other');
  it.each(guided)('%s: hosted StoryOS is OAuth, so no step asks for a token', (c) => {
    for (const s of CONNECT_CLIENTS[c].steps('W')) expect(stepText(s)).not.toMatch(/token|mn_pat/i);
  });

  describe('Other (#988): the generic server address and the OAuth-or-token choice', () => {
    const steps = CONNECT_CLIENTS.other.steps('JCM Agency').map(stepText);
    it('shows the address (the shared block) and puts OAuth first, with the Allow page described', () => {
      const oauth = steps.findIndex((s) => /OAuth/.test(s));
      const token = steps.findIndex((s) => /token/i.test(s));
      expect(oauth).toBeGreaterThan(-1);
      expect(token).toBeGreaterThan(oauth);
      expect(steps[oauth]).toMatch(/it reaches all your workspaces unless you choose One workspace/);
      expect(steps[oauth]).toMatch(/Allow/);
    });
    it('the token way names where to make one, that it is shown once, and never to paste it into a sign-in page', () => {
      const token = steps.find((s) => /token/i.test(s))!;
      expect(token).toContain('Settings → API tokens');
      expect(token).toContain('shown once');
      expect(token).toContain('Authorization: Bearer');
      expect(token).toContain('Never paste a token into a sign-in page');
    });
    it('says what a client must support, instead of leaving a local-only tool to find out', () => {
      expect(steps[0]).toMatch(/remote MCP server/);
      expect(steps[0]).toMatch(/streamable HTTP/);
    });
    it('is plain text: no brand', () => {
      expect(CONNECT_CLIENTS.other.label).toBe('Other');
    });
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

// #1079 — Ievgen's decision: no access level, and every connection reaches all the person's workspaces unless they pick one.
describe('no guide mentions an access level, and none tells the person to pick a workspace (#1079)', () => {
  it.each(clients)('%s', (c) => {
    const text = CONNECT_CLIENTS[c].steps('JCM Agency').map(stepText).join(' ');
    expect(text).not.toMatch(/read only|read and write|read-only|access level/i);
    expect(text).not.toMatch(/\bpick JCM Agency\b/);
    expect(text).toMatch(/all your workspaces/i);
  });
});
