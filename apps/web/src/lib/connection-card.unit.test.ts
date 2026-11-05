import { describe, expect, it } from 'vitest';
import { connectionCardModel, needsAttention, type CardConnection } from './connection-card';

/** Ticket #1188 — the shared connection card, one case per state it can be in. */
const active: CardConnection = { status: 'active' };

describe('connectionCardModel: the five states', () => {
  it('connected and healthy: Working, and Test + Disconnect (no Connect, no Reconnect)', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: active, oauth: true });
    expect(m.state).toBe('connected');
    expect(m.pill).toEqual({ tone: 'ok', label: 'Working' });
    expect(m.actions).toEqual(['test', 'disconnect']);
  });

  it('needs attention: an expired OAuth credential offers Reconnect as well, and says what is wrong', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: { status: 'expired' }, oauth: true });
    expect(m.state).toBe('needs_attention');
    expect(m.pill.tone).toBe('bad');
    expect(m.pill.label).toBe('Expired');
    expect(m.actions).toEqual(['test', 'reconnect', 'disconnect']);
    expect(m.summary).toMatch(/reconnect/i);
  });

  it('needs attention on a self-managed server with no OAuth app: NO Reconnect (it would only fail), but Test and Disconnect stay', () => {
    const m = connectionCardModel({ availability: 'operator_config', connection: { status: 'expired' }, oauth: true });
    expect(m.state).toBe('needs_attention');
    expect(m.actions).toEqual(['test', 'disconnect']);
  });

  it('needs attention: an API key that stopped working has NO Reconnect (a key is replaced by connecting again)', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: { status: 'error' }, oauth: false });
    expect(m.state).toBe('needs_attention');
    expect(m.actions).not.toContain('reconnect');
    expect(m.actions).toContain('disconnect');
    expect(m.summary).toBe('Not working: check the key, or connect it again.');
  });

  it('needs attention while still ACTIVE: provider-reported trouble (GitHub repos still sending events) is a warning, not a failure', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: { status: 'active', problem: '11 repositories you don’t track are still sending events.' } });
    expect(m.state).toBe('needs_attention');
    expect(m.pill).toEqual({ tone: 'warn', label: 'Needs a look' });
    expect(m.summary).toBe('11 repositories you don’t track are still sending events.');
    expect(m.actions).toEqual(['test', 'disconnect']);
  });

  it('not connected and connectable: Connect, and nothing to test or disconnect', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: null });
    expect(m.state).toBe('not_connected');
    expect(m.actions).toEqual(['connect']);
  });

  it('operator_config (Tier B on a self-managed server with the env absent): information, NEVER a Connect button', () => {
    const m = connectionCardModel({ availability: 'operator_config', connection: null });
    expect(m.state).toBe('operator_config');
    expect(m.actions).toEqual([]);
    expect(m.pill.label).toBe('Configured by your admin');
    expect(m.summary).toMatch(/self-hosting/i);
  });

  it('cloud_only (Tier C off hosted): an upsell sentence, never a Connect button; the server note overrides the default', () => {
    const def = connectionCardModel({ availability: 'cloud_only', connection: null });
    expect(def.state).toBe('cloud_only');
    expect(def.actions).toEqual([]);
    expect(def.pill.label).toBe('Available on StoryOS Cloud');
    expect(connectionCardModel({ availability: 'cloud_only', availabilityNote: 'Only on Cloud.', connection: null }).summary).toBe('Only on Cloud.');
  });
});

describe('what a connection that already exists wins over', () => {
  it('Disconnect is present whenever something is connected, whatever the availability verdict now says', () => {
    for (const availability of ['connectable', 'operator_config', 'cloud_only'] as const) {
      for (const status of ['active', 'expired', 'revoked', 'error'] as const) {
        const m = connectionCardModel({ availability, connection: { status } });
        expect(m.actions, `${availability}/${status}`).toContain('disconnect');
        expect(m.actions, `${availability}/${status}`).toContain('test');
        expect(m.actions, `${availability}/${status}`).not.toContain('connect');
      }
    }
  });

  it('a card with nothing connected never offers Disconnect or Test', () => {
    for (const availability of ['connectable', 'operator_config', 'cloud_only'] as const) {
      const m = connectionCardModel({ availability, connection: null });
      expect(m.actions).not.toContain('disconnect');
      expect(m.actions).not.toContain('test');
    }
  });
});

describe('needsAttention', () => {
  it('each trouble signal alone is enough, and a clean active connection is not', () => {
    expect(needsAttention(active)).toBe(false);
    expect(needsAttention({ status: 'active', errorCount24h: 0, breakerOpenUntil: null, needsBaseUrl: false, problem: null })).toBe(false);
    expect(needsAttention({ status: 'active', errorCount24h: 2 })).toBe(true);
    expect(needsAttention({ status: 'active', breakerOpenUntil: '2026-11-05T10:00:00Z' })).toBe(true);
    expect(needsAttention({ status: 'active', needsBaseUrl: true })).toBe(true);
    expect(needsAttention({ status: 'revoked' })).toBe(true);
  });

  it('an HTTP connection with no base URL says it sends nothing (the #1035 sentence is kept)', () => {
    const m = connectionCardModel({ availability: 'connectable', connection: { status: 'active', needsBaseUrl: true } });
    expect(m.summary).toMatch(/sends nothing/);
  });

  it('failed jobs are counted in words, singular and plural', () => {
    expect(connectionCardModel({ availability: 'connectable', connection: { status: 'active', errorCount24h: 1 } }).summary).toBe('1 job failed in the last 24 hours.');
    expect(connectionCardModel({ availability: 'connectable', connection: { status: 'active', errorCount24h: 3 } }).summary).toBe('3 jobs failed in the last 24 hours.');
  });
});
