import { describe, expect, it } from 'vitest';
import { settingsHomeCards, settingsNavCounts, type SettingsSignals } from './settings-home';
import { deriveSettingsSignals } from './settings-signals';

const fmt = (iso: string) => `on ${iso.slice(0, 10)}`;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const ids = (role: string, s: SettingsSignals = {}) => settingsHomeCards(role, s, fmt).map((c) => c.id);
const card = (role: string, id: string, s: SettingsSignals) => settingsHomeCards(role, s, fmt).find((c) => c.id === id)!;

describe('the home page cards, per role (ticket #1185)', () => {
  it('an admin gets a card for every area; a member only You, Connect your AI and API tokens; a guest only You', () => {
    expect(ids('admin')).toEqual(['you', 'members', 'connect-ai', 'api-tokens', 'integrations', 'packs', 'data']);
    expect(ids('member')).toEqual(['you', 'connect-ai', 'api-tokens']);
    expect(ids('guest')).toEqual(['you']);
  });
});

describe('counts come only from data the server reported (no invented numbers)', () => {
  it('with nothing reported, no card carries a count or a warning', () => {
    for (const c of settingsHomeCards('admin', {}, fmt)) {
      expect(c.tone, c.id).toBeUndefined();
      if (c.id !== 'data') expect(c.headline, c.id).toBeUndefined();
    }
  });
  it('an UNKNOWN is not a zero: members never asked shows no "0 people"; a reported zero IS shown', () => {
    expect(card('admin', 'members', {}).headline).toBeUndefined();
    expect(card('admin', 'members', { members: 0 }).headline).toBe('0 people');
    expect(card('admin', 'api-tokens', {}).headline).toBeUndefined();
    expect(card('admin', 'api-tokens', { tokens: 0 }).headline).toBe('0 tokens');
  });
  it('a query that has not answered (or failed) leaves its signal undefined, never 0, for every signal', () => {
    const s = deriveSettingsSignals({}, NOW);
    for (const [k, v] of Object.entries(s)) expect(v, k).toBeUndefined();
    expect(Object.keys(s)).toEqual(['userName']);
  });
  it('expired invitations warn, and are counted from expires_at against now, not from a stored flag', () => {
    const s = deriveSettingsSignals(
      { members: [1, 2, 3, 4, 5], invites: [{ expires_at: '2026-08-25T00:00:00Z' }, { expires_at: '2026-08-25T00:00:00Z' }, { expires_at: '2026-12-01T00:00:00Z' }] },
      NOW,
    );
    expect(s).toMatchObject({ members: 5, invitesExpired: 2, invitesPending: 1 });
    const c = card('admin', 'members', s);
    expect(c.headline).toBe('5 people');
    expect(c.detail).toBe('2 invitations expired');
    expect(c.tone).toBe('warn');
    expect(settingsNavCounts('admin', s).members).toEqual({ text: '2 expired', warn: true });
  });
  it('an invitation expiring in the future is NOT shown as expired', () => {
    const s = deriveSettingsSessionlessInvites([{ expires_at: '2026-11-03T12:00:01Z' }]);
    expect(s.invitesExpired).toBe(0);
    expect(card('admin', 'members', s).tone).toBeUndefined();
    expect(card('admin', 'members', s).detail).toBe('1 invitation waiting to be accepted');
    expect(settingsNavCounts('admin', s).members).toBeUndefined();
  });
  it('AI: working = connected minus those the server says need reconnecting; a token counts, as it does on the Connect your AI page', () => {
    const s = deriveSettingsSignals(
      {
        aiConnections: [
          { kind: 'oauth', reaches: 'needs_reconnect' },
          { kind: 'oauth', reaches: 'needs_reconnect' },
          { kind: 'oauth', reaches: 'all_workspaces' },
          { kind: 'oauth', reaches: 'one_workspace' },
          { kind: 'token', reaches: 'this_workspace' },
        ],
      },
      NOW,
    );
    expect(s).toMatchObject({ aiApps: 5, aiNeedReconnect: 2 });
    const c = card('member', 'connect-ai', s);
    expect(c.headline).toBe('3 connections working');
    expect(c.detail).toBe('2 need reconnecting');
    expect(c.tone).toBe('warn');
    expect(settingsNavCounts('member', s)['connect-ai']).toEqual({ text: '2 to fix', warn: true });
  });
  it('AI apps with nothing to fix: no warning, and no "to fix" count in the nav', () => {
    const s = deriveSettingsSignals({ aiConnections: [{ kind: 'oauth', reaches: 'all_workspaces' }] }, NOW);
    expect(card('member', 'connect-ai', s)).toMatchObject({ headline: '1 connection working' });
    expect(card('member', 'connect-ai', s).tone).toBeUndefined();
    expect(settingsNavCounts('member', s)['connect-ai']).toBeUndefined();
  });
  it('no AI connected is said plainly, not as "0 apps working"', () => {
    const s = deriveSettingsSignals({ aiConnections: [] }, NOW);
    expect(card('member', 'connect-ai', s).headline).toBe('No AI connected');
  });
  it('API tokens: the count and the most recent use among them', () => {
    const s = deriveSettingsSignals({ tokens: [{ last_used_at: '2026-10-01T00:00:00Z' }, { last_used_at: '2026-11-02T08:00:00Z' }, { last_used_at: null }] }, NOW);
    expect(card('member', 'api-tokens', s)).toMatchObject({ headline: '3 tokens', detail: 'Last used on 2026-11-02' });
    const never = deriveSettingsSignals({ tokens: [{ last_used_at: null }] }, NOW);
    expect(card('member', 'api-tokens', never)).toMatchObject({ headline: '1 token', detail: 'Never used' });
  });
  it('integrations: connections that are not active need attention; their names list only the working ones', () => {
    const s = deriveSettingsSignals(
      { connections: [{ name: 'GitHub', status: 'active' }, { name: 'Linear', status: 'active' }, { name: 'Slack', status: 'expired' }] },
      NOW,
    );
    const c = card('admin', 'integrations', s);
    expect(c.headline).toBe('2 connected');
    expect(c.detail).toBe('1 needs attention');
    expect(c.tone).toBe('warn');
    const ok = deriveSettingsSignals({ connections: [{ name: 'GitHub', status: 'active' }, { name: 'Linear', status: 'active' }] }, NOW);
    expect(card('admin', 'integrations', ok)).toMatchObject({ headline: '2 connected', detail: 'GitHub · Linear' });
    expect(card('admin', 'integrations', ok).tone).toBeUndefined();
  });
  it('packs: one pack is named, updates warn, and none says so', () => {
    expect(card('admin', 'packs', deriveSettingsSignals({ packs: [{ name: 'Agency OS', update_available: false }] }, NOW))).toMatchObject({
      headline: 'Agency OS',
      detail: 'Up to date',
    });
    const upd = card('admin', 'packs', deriveSettingsSignals({ packs: [{ name: 'A', update_available: true }, { name: 'B', update_available: false }] }, NOW));
    expect(upd).toMatchObject({ headline: '2 packs installed', detail: '1 update available', tone: 'warn' });
    expect(card('admin', 'packs', deriveSettingsSignals({ packs: [] }, NOW)).headline).toBe('None installed');
  });
});

describe('what a role is never shown', () => {
  it('a member gets no admin count in the nav even if the data is somehow present', () => {
    const s: SettingsSignals = { invitesExpired: 3, connections: 4, connectionsNeedFix: 1, packs: 2, aiNeedReconnect: 1, tokens: 2 };
    const counts = settingsNavCounts('member', s);
    expect(counts.members).toBeUndefined();
    expect(counts.integrations).toBeUndefined();
    expect(counts.packs).toBeUndefined();
    expect(counts['connect-ai']).toBeDefined();
    expect(counts['api-tokens']).toBeDefined();
  });
  it('a guest gets no counts at all', () => {
    expect(settingsNavCounts('guest', { invitesExpired: 3, aiNeedReconnect: 1, tokens: 2, connections: 1, packs: 1 })).toEqual({});
  });
  it('the warning tone is carried by data, never by a colour name: warn cards use the warning-text token on the page', () => {
    expect(settingsHomeCards('admin', { invitesExpired: 1 }, fmt).filter((c) => c.tone === 'warn').map((c) => c.id)).toEqual(['members']);
  });
});

function deriveSettingsSessionlessInvites(invites: Array<{ expires_at: string }>) {
  return deriveSettingsSignals({ invites }, NOW);
}
