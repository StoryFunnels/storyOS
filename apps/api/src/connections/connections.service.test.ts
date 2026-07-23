import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { NotificationsService } from '../notifications/notifications.service';
import { ConnectionsService } from './connections.service';

/** authorizeUrl/verifyOAuthState never touch the db or notifications — a stub
 * is enough (mirrors the db-stub pattern in integrations/slack.service.test.ts). */
function newService(): ConnectionsService {
  return new ConnectionsService({} as Db, {} as NotificationsService);
}

describe('ConnectionsService OAuth state (MN-252)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('round-trips a signed state through authorizeUrl → verifyOAuthState', () => {
    const service = newService();
    const url = service.authorizeUrl('ws-1', 'google', 'user-1');
    const state = new URL(url).searchParams.get('state')!;

    const verified = service.verifyOAuthState(state);
    expect(verified).toEqual(
      expect.objectContaining({ ws: 'ws-1', provider: 'google', uid: 'user-1' }),
    );
  });

  it('builds the authorize URL with the client id, scopes and extra params', () => {
    const service = newService();
    const url = new URL(service.authorizeUrl('ws-1', 'google', 'user-1'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('openid');
  });

  it('keeps Calendar write access on a dedicated provider', () => {
    const service = newService();
    const calendarUrl = new URL(service.authorizeUrl('ws-1', 'google-calendar', 'user-1'));
    const youtubeUrl = new URL(service.authorizeUrl('ws-1', 'google', 'user-1'));

    expect(calendarUrl.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/calendar',
    );
    expect(calendarUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(youtubeUrl.searchParams.get('scope')).not.toContain(
      'https://www.googleapis.com/auth/calendar',
    );
  });

  it('rejects an unknown provider', () => {
    const service = newService();
    expect(() => service.authorizeUrl('ws-1', 'not-a-provider', 'user-1')).toThrow(
      NotFoundException,
    );
  });

  it('rejects a provider that does not support OAuth (e.g. apify)', () => {
    const service = newService();
    expect(() => service.authorizeUrl('ws-1', 'apify', 'user-1')).toThrow(NotFoundException);
  });

  it('rejects starting OAuth when the server has no client id/secret configured', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const service = newService();
    expect(() => service.authorizeUrl('ws-1', 'google', 'user-1')).toThrow(NotFoundException);
  });

  it('rejects a tampered state (flipped signature byte)', () => {
    const service = newService();
    const url = service.authorizeUrl('ws-1', 'google', 'user-1');
    const state = new URL(url).searchParams.get('state')!;
    const dot = state.lastIndexOf('.');
    const data = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    expect(service.verifyOAuthState(`${data}.${tamperedSig}`)).toBeNull();
  });

  it('rejects a state whose payload was tampered with (workspace swap)', () => {
    const service = newService();
    const url = service.authorizeUrl('ws-1', 'google', 'user-1');
    const state = new URL(url).searchParams.get('state')!;
    const dot = state.lastIndexOf('.');
    const payload = JSON.parse(Buffer.from(state.slice(0, dot), 'base64url').toString('utf8'));
    const tamperedData = Buffer.from(
      JSON.stringify({ ...payload, ws: 'someone-elses-workspace' }),
    ).toString('base64url');
    // Re-using the original (now-mismatched) signature — this is exactly what
    // an attacker who can't compute a valid HMAC would try.
    expect(service.verifyOAuthState(`${tamperedData}.${state.slice(dot + 1)}`)).toBeNull();
  });

  it('rejects a missing or malformed state', () => {
    const service = newService();
    expect(service.verifyOAuthState(undefined)).toBeNull();
    expect(service.verifyOAuthState('')).toBeNull();
    expect(service.verifyOAuthState('not-a-real-state')).toBeNull();
  });

  it('rejects an expired state (older than 10 minutes)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const service = newService();
    const url = service.authorizeUrl('ws-1', 'google', 'user-1');
    const state = new URL(url).searchParams.get('state')!;

    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // +11 minutes
    expect(service.verifyOAuthState(state)).toBeNull();
  });
});
