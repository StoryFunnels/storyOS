import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { googleProvider } from './google';
import type { ConnectionFetcher } from './types';

function fetcherReturning(status: number) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, json: async () => ({}), text: async () => '' };
  };
  return { fetcher, calls };
}

describe('googleProvider', () => {
  it('is an oauth2 descriptor reusing GOOGLE_CLIENT_ID/SECRET', () => {
    expect(googleProvider.authKind).toBe('oauth2');
    expect(googleProvider.oauth?.clientIdEnv).toBe('GOOGLE_CLIENT_ID');
    expect(googleProvider.oauth?.clientSecretEnv).toBe('GOOGLE_CLIENT_SECRET');
    // access_type=offline + prompt=consent is what actually gets a refresh_token.
    expect(googleProvider.oauth?.extraAuthParams).toEqual({ access_type: 'offline', prompt: 'consent' });
  });

  describe('healthCheck', () => {
    it('accepts a valid access token (200 from userinfo)', async () => {
      const { fetcher, calls } = fetcherReturning(200);
      await expect(googleProvider.healthCheck({ access_token: 'ya29.abc' }, fetcher)).resolves.toBeUndefined();
      expect(calls[0]!.url).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
      expect(calls[0]!.headers?.authorization).toBe('Bearer ya29.abc');
    });

    it('rejects an expired/invalid token with a 422', async () => {
      const { fetcher } = fetcherReturning(401);
      await expect(googleProvider.healthCheck({ access_token: 'expired' }, fetcher)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('rejects a missing access_token without a network call', async () => {
      const { fetcher, calls } = fetcherReturning(200);
      await expect(googleProvider.healthCheck({}, fetcher)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(calls).toHaveLength(0);
    });
  });
});
