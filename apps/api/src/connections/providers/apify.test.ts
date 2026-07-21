import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { apifyProvider } from './apify';
import type { ConnectionFetcher } from './types';

function fetcherReturning(status: number) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, json: async () => ({}), text: async () => '' };
  };
  return { fetcher, calls };
}

describe('apifyProvider.healthCheck', () => {
  it('accepts a valid token (200 from /v2/users/me)', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(apifyProvider.healthCheck({ api_key: 'apify_api_123' }, fetcher)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.apify.com/v2/users/me');
    expect(calls[0]!.headers?.authorization).toBe('Bearer apify_api_123');
  });

  it('rejects a bad token (non-2xx) with a 422', async () => {
    const { fetcher } = fetcherReturning(401);
    await expect(apifyProvider.healthCheck({ api_key: 'bad' }, fetcher)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rejects a missing api_key without a network call', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(apifyProvider.healthCheck({}, fetcher)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });
});
