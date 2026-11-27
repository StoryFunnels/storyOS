import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_SLACK_PREFIX,
  DUPLICATE_CHANNEL_LINE,
  RESTRICTED_REFUSAL_PREFIX,
  addDraft,
  attentionLine,
  channelInSentence,
  channelLabel,
  errorCode,
  eventsLine,
  forTarget,
  isConnectSlackRefusal,
  isRestrictedRefusal,
  restrictedNotice,
} from './slack-subscriptions';
import type { SlackSubscriptionDto } from './slack-subscriptions';

/** Ticket #1388 — how the Slack subscriptions screen words and checks what the API sends. */
const row = (over: Partial<SlackSubscriptionDto> = {}): SlackSubscriptionDto => ({
  id: 's1',
  channel: 'general',
  events: ['created', 'status_changed', 'commented'],
  created_by: 'u1',
  created_by_name: 'Maya Chen',
  needs_attention: null,
  sent_count: 0,
  failed_count: 0,
  last_error: null,
  last_error_at: null,
  last_sent_at: null,
  created_at: '2026-11-20T10:00:00Z',
  scope: { kind: 'database', id: 'db1', name: 'Issues' },
  closed: false,
  ...over,
});

describe('#1388 forTarget', () => {
  const list = [
    row({ id: 'a', scope: { kind: 'database', id: 'db1', name: 'Issues' } }),
    row({ id: 'b', scope: { kind: 'space', id: 'sp1', name: 'Eng' } }),
    row({ id: 'c', scope: { kind: 'database', id: 'db2', name: 'Bugs', space_id: 'sp1' } }),
    row({ id: 'd', scope: { kind: 'space', id: 'db1', name: 'Same id, other kind' } }),
  ];
  it("keeps exactly this target's rows: same kind AND id", () => {
    expect(forTarget(list, 'database', 'db1').map((r) => r.id)).toEqual(['a']);
    expect(forTarget(list, 'space', 'sp1').map((r) => r.id)).toEqual(['b']);
  });
  it("a space's list does not include its databases' subscriptions, and an unknown target is empty", () => {
    expect(forTarget(list, 'space', 'sp1').map((r) => r.id)).not.toContain('c');
    expect(forTarget(list, 'database', 'nope')).toEqual([]);
  });
});

describe('#1388 the words', () => {
  it('events read as one line in the API order, first word capitalised', () => {
    expect(eventsLine(['created', 'status_changed', 'commented'])).toBe('Record created, status changed, comment added');
    expect(eventsLine(['commented'])).toBe('Comment added');
    expect(eventsLine(['commented', 'created'])).toBe('Record created, comment added');
    expect(eventsLine([])).toBe('No events');
  });

  it('a channel name reads with a #, an id as it is, none as the connection’s own', () => {
    expect(channelLabel('general')).toBe('#general');
    expect(channelLabel('#general')).toBe('#general');
    expect(channelLabel('C0123ABCDEF')).toBe('C0123ABCDEF');
    expect(channelLabel(null)).toBe('The connection’s channel');
    expect(channelLabel('  ')).toBe('The connection’s channel');
  });

  it('in a sentence a default channel is lower case, a named one is unchanged', () => {
    expect(channelInSentence(null)).toBe('the connection’s channel');
    expect(channelInSentence('general')).toBe('#general');
  });

  it('a subscription that is not posting says so, naming who and why; a healthy one says nothing', () => {
    expect(attentionLine(null, 'Maya Chen')).toBeNull();
    expect(attentionLine('creator_not_admin', 'Maya Chen')).toMatch(/Not posting: Maya Chen is no longer an admin/);
    expect(attentionLine('creator_left', 'Maya Chen')).toMatch(/Not posting: Maya Chen is no longer in this workspace/);
    // The screen has no edit, so the way back is stated as what the person can do here.
    for (const c of ['creator_left', 'creator_not_admin'] as const) expect(attentionLine(c, 'Maya Chen')).toContain('Remove it, then add the channel again as yourself.');
    expect(attentionLine('creator_left', null)).toMatch(/the admin who added it/);
  });
});

describe('#1388 addDraft', () => {
  const ok = { events: ['created'] as const, channel: '#general', needsAcknowledge: false, acknowledged: false };

  it('sends the chosen events in the API order and the channel as typed (trimmed)', () => {
    expect(addDraft({ ...ok, events: ['commented', 'created'], channel: '  #general ' }).body).toEqual({ events: ['created', 'commented'], channel: '#general' });
  });

  it('an empty channel is allowed (a webhook workspace) and is left out, not sent as ""', () => {
    expect(addDraft({ ...ok, channel: '   ' }).body).toEqual({ events: ['created'] });
  });

  it('no event picked is refused, with a sentence', () => {
    const d = addDraft({ ...ok, events: [] });
    expect(d.body).toBeNull();
    expect(d.error).toBe('Pick at least one event.');
  });

  it('a channel over 100 characters is refused, 100 is accepted', () => {
    expect(addDraft({ ...ok, channel: 'a'.repeat(101) }).error).toMatch(/at most 100/);
    expect(addDraft({ ...ok, channel: 'a'.repeat(100) }).body).not.toBeNull();
  });

  it('a restricted target waits for the confirmed notice (no error shown, nothing sent), then sends acknowledge_restricted', () => {
    const waiting = addDraft({ ...ok, needsAcknowledge: true, acknowledged: false });
    expect(waiting).toEqual({ body: null, error: null });
    expect(addDraft({ ...ok, needsAcknowledge: true, acknowledged: true }).body).toEqual({ events: ['created'], channel: '#general', acknowledge_restricted: true });
  });

  it('an open target never sends the acknowledgement, even if the box was ticked', () => {
    expect(addDraft({ ...ok, needsAcknowledge: false, acknowledged: true }).body).not.toHaveProperty('acknowledge_restricted');
  });
});

describe('#1388 the restricted refusal', () => {
  it("is recognised by the API's own opening words, and ordinary refusals are not mistaken for it", () => {
    expect(isRestrictedRefusal(`${RESTRICTED_REFUSAL_PREFIX}: its titles go to a channel...`)).toBe(true);
    expect(isRestrictedRefusal('Connect Slack first')).toBe(false);
    expect(isRestrictedRefusal(undefined)).toBe(false);
  });

  // The API has no code for this refusal today, so the screen matches its wording. If the wording moves, this fails instead of the notice silently never appearing.
  it("the prefix is in the API's source", () => {
    const api = readFileSync(fileURLToPath(new URL('../../../api/src/integrations/slack-subscriptions.service.ts', import.meta.url)), 'utf8');
    expect(api).toContain(RESTRICTED_REFUSAL_PREFIX);
  });
});

describe('#1388 refusals the screen words itself', () => {
  it('a restricted database that only inherits its restriction is not called restricted itself', () => {
    expect(restrictedNotice('database', 'Props')).toContain('Props is a restricted database');
    const inherited = restrictedNotice('database', 'Props', true);
    expect(inherited).toContain('Props sits in a restricted space');
    expect(inherited).not.toContain('Props is a restricted database');
    expect(inherited).toContain('Its record titles will be posted');
  });

  it('a 409 is read from the error code, and anything else (or nothing) is not', () => {
    expect(errorCode({ error: { code: 'conflict', message: 'x' } })).toBe('conflict');
    expect(errorCode({ error: { code: 'validation_failed' } })).toBe('validation_failed');
    expect(errorCode({ message: 'x' })).toBeNull();
    expect(errorCode(null)).toBeNull();
  });

  it('the duplicate-channel line points at what this screen can do, not at an edit it lacks', () => {
    expect(DUPLICATE_CHANNEL_LINE).toMatch(/Remove it first/);
    expect(DUPLICATE_CHANNEL_LINE).not.toMatch(/Change the existing/);
  });

  it('"Connect Slack first" is recognised by its opening words, and the opening words are in the API source', () => {
    expect(isConnectSlackRefusal('Connect Slack first (a bot token or an incoming webhook) in the workspace Slack settings')).toBe(true);
    expect(isConnectSlackRefusal('This space or database is restricted')).toBe(false);
    expect(isConnectSlackRefusal(null)).toBe(false);
    const api = readFileSync(fileURLToPath(new URL('../../../api/src/integrations/slack-subscriptions.service.ts', import.meta.url)), 'utf8');
    expect(api).toContain(CONNECT_SLACK_PREFIX);
  });
});
