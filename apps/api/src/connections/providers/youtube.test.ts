import { describe, expect, it, vi } from 'vitest';
import { availabilityFor } from './availability';
import { googleProvider } from './google';
import { PROVIDER_REGISTRY } from './index';
import { YOUTUBE_CHANNEL_ID, YOUTUBE_SCOPES, youtubeProvider } from './youtube';

/**
 * Ticket #60 — the YouTube upload provider's descriptor and where it shows up in the gallery. No real Google app or
 * credential exists: the env maps below are made-up strings and the health check runs against a fake fetcher.
 */
const ENV_PRESENT = { YOUTUBE_CLIENT_ID: 'client-id-not-real', YOUTUBE_CLIENT_SECRET: 'client-secret-not-real' };

describe('the descriptor', () => {
  it('is its own provider, registered, Tier B, with a DEDICATED client (not the sign-in one)', () => {
    expect(PROVIDER_REGISTRY.get('youtube')).toBe(youtubeProvider);
    expect(youtubeProvider.tier).toBe('oauth_managed');
    expect(youtubeProvider.authKind).toBe('oauth2');
    expect(youtubeProvider.oauth!.clientIdEnv).toBe('YOUTUBE_CLIENT_ID');
    expect(youtubeProvider.oauth!.clientSecretEnv).toBe('YOUTUBE_CLIENT_SECRET');
    expect(youtubeProvider.oauth!.clientIdEnv).not.toBe(googleProvider.oauth!.clientIdEnv);
    expect(youtubeProvider.oauth!.extraAuthParams).toMatchObject({ access_type: 'offline', prompt: 'consent' });
  });

  it('asks for the two scopes it needs and nothing wider', () => {
    expect(YOUTUBE_SCOPES).toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
    expect(youtubeProvider.oauth!.scopes).toEqual(YOUTUBE_SCOPES);
    // no sign-in scopes (openid/email), no edit/delete scope (youtube, youtube.force-ssl), no partner scope
    expect(youtubeProvider.oauth!.scopes).toHaveLength(2);
  });

  it('did NOT widen the existing google provider: its consent still has no upload scope', () => {
    expect(googleProvider.oauth!.scopes.join(' ')).not.toContain('youtube.upload');
    expect(googleProvider.id).toBe('google');
  });

  it('a channel id is `UC` and 22 url-safe characters, and nothing else', () => {
    expect(YOUTUBE_CHANNEL_ID.test('UCabcdefghijklmnopqrstuv')).toBe(true);
    for (const bad of ['', 'UC', 'ucabcdefghijklmnopqrstuv', 'UCabcdefghijklmnopqrstu', 'UCabcdefghijklmnopqrstuvw', '@foxglove', 'UCabcdefghijklmnopqrst v', 'https://youtube.com/channel/UCabcdefghijklmnopqrstuv']) {
      expect(YOUTUBE_CHANNEL_ID.test(bad), bad).toBe(false);
    }
  });

  it('carries a per-connection daily upload ceiling, so the job runner\'s rate budget applies', () => {
    expect(youtubeProvider.rateLimit).toEqual({ capacity: 6, refillMs: 86_400_000 });
  });
});

describe('availability across both deployment modes and the operator env', () => {
  it.each([
    ['hosted', true, ENV_PRESENT, 'connectable'],
    ['hosted, env absent (managed app)', true, {}, 'connectable'],
    ['self-managed with the operator app', false, ENV_PRESENT, 'connectable'],
    ['self-managed without it', false, {}, 'operator_config'],
    ['self-managed with only the id', false, { YOUTUBE_CLIENT_ID: 'x' }, 'operator_config'],
    ['self-managed with only the secret', false, { YOUTUBE_CLIENT_SECRET: 'x' }, 'operator_config'],
    ['self-managed with blanks', false, { YOUTUBE_CLIENT_ID: ' ', YOUTUBE_CLIENT_SECRET: '' }, 'operator_config'],
  ] as const)('%s', (_name, isHosted, env, expected) => {
    expect(availabilityFor(youtubeProvider, { isHosted, env })).toBe(expected);
  });

  it('is never cloud_only: a self-managed operator can turn it on, it is not an upsell', () => {
    for (const isHosted of [true, false]) for (const env of [{}, ENV_PRESENT]) expect(availabilityFor(youtubeProvider, { isHosted, env })).not.toBe('cloud_only');
  });

  it('the GOOGLE client env does not make YouTube upload connectable', () => {
    expect(availabilityFor(youtubeProvider, { isHosted: false, env: { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } })).toBe('operator_config');
  });
});

describe('the health check', () => {
  it('asks for the token\'s channels and passes on a 2xx; the token travels in a header, never a URL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}), text: async () => '' });
    await youtubeProvider.healthCheck({ access_token: 'tok-not-real' }, fetcher);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?/);
    expect(String(url)).not.toContain('tok-not-real');
    expect(init.headers.authorization).toBe('Bearer tok-not-real');
  });
  it('fails with a sentence on a refusal and on a missing token', async () => {
    const refuse = vi.fn().mockResolvedValue({ status: 401, json: async () => ({}), text: async () => '' });
    await expect(youtubeProvider.healthCheck({ access_token: 'x' }, refuse)).rejects.toThrow(/HTTP 401/);
    await expect(youtubeProvider.healthCheck({}, refuse)).rejects.toThrow(/missing an access token/);
    expect(refuse).toHaveBeenCalledTimes(1);
  });
});
