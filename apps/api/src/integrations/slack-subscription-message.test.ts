import { describe, expect, it } from 'vitest';
import { renderCoalescedMessage, renderSubscriptionMessage } from './slack-subscription-message';
import { slackChannelProblem } from './slack-subscriptions.service';

const base = { title: 'Fix login', identifier: null, state: 'Todo', actorName: 'Ada', via: null, url: 'https://app.example/r/1' } as const;

describe('ticket #1377 - the message a subscription posts', () => {
  it('carries the title, identifier, state, actor and a link, and says what happened', () => {
    const text = renderSubscriptionMessage({ ...base, kind: 'created', identifier: 'ISSUE-12' });
    expect(text).toContain('<https://app.example/r/1|ISSUE-12 Fix login>');
    expect(text).toContain('*Ada*');
    expect(text).toContain('created');
    expect(text).toContain('*Todo*');
    const moved = renderSubscriptionMessage({ ...base, kind: 'status_changed', state: 'Done', previousState: 'Doing' });
    expect(moved).toContain('*Doing* → *Done*');
    expect(renderSubscriptionMessage({ ...base, kind: 'commented' })).toContain('commented on');
  });

  it('every person-controlled string is escaped, so nothing pings or disguises a link', () => {
    const text = renderSubscriptionMessage({
      kind: 'status_changed',
      title: '<!channel> <https://evil|Click>',
      identifier: null,
      state: '<!here>',
      previousState: '<@U1>',
      actorName: '<!everyone>',
      via: null,
      url: 'https://app.example/r/1',
    });
    for (const raw of ['<!channel>', '<https://evil', '<!here>', '<@U1>', '<!everyone>']) expect(text).not.toContain(raw);
    expect(text).toContain('&lt;!channel&gt;');
  });

  it('an empty title reads Untitled, an unknown actor Someone, a long title is cut to one line', () => {
    expect(renderSubscriptionMessage({ ...base, kind: 'created', title: '  ', actorName: null })).toContain('Untitled');
    expect(renderSubscriptionMessage({ ...base, kind: 'created', title: '  ', actorName: null })).toContain('*Someone*');
    const long = renderSubscriptionMessage({ ...base, kind: 'created', title: `${'x'.repeat(400)}\nsecond line` });
    expect(long).not.toContain('second line');
    expect(long.length).toBeLessThan(400);
  });

  it('says via agent / automation / MCP / sync, never an AI as the actor', () => {
    for (const [via, words] of [['agent', 'via agent'], ['automation', 'via automation'], ['mcp', 'via MCP'], ['sync', 'via sync']] as const) {
      expect(renderSubscriptionMessage({ ...base, kind: 'created', via })).toContain(words);
    }
    expect(renderSubscriptionMessage({ ...base, kind: 'created', via: null })).not.toContain('via ');
  });

  it('the coalesced line has a count and names nothing', () => {
    const text = renderCoalescedMessage(37);
    expect(text).toContain('37');
    expect(text).not.toContain('<');
  });
});

describe('ticket #1377 - which channels a subscription may name', () => {
  it('accepts a public name or a C id and drops a leading #', () => {
    expect(slackChannelProblem('#eng-team')).toEqual({ channel: 'eng-team' });
    expect(slackChannelProblem('general')).toEqual({ channel: 'general' });
    expect(slackChannelProblem('C0123ABCDEF')).toEqual({ channel: 'C0123ABCDEF' });
  });
  it('refuses private (G), direct-message (D) and user (U, W) ids and anything that is not a channel', () => {
    for (const bad of ['G0123456789', 'D0123456789', 'U0123456789', 'W0123456789', '', 'two words', '@ada', 'UPPER', '-lead']) {
      expect('problem' in slackChannelProblem(bad), bad).toBe(true);
    }
  });
});
