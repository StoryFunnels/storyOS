import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { resendProvider } from './resend';
import type { ConnectionFetcher } from './types';

function fetcherReturning(status: number) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, json: async () => ({}), text: async () => '' };
  };
  return { fetcher, calls };
}

describe('resendProvider.healthCheck', () => {
  it('accepts a valid key (200 from /domains)', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(resendProvider.healthCheck({ api_key: 're_test_123' }, fetcher)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('https://api.resend.com/domains');
    expect(calls[0]!.headers?.authorization).toBe('Bearer re_test_123');
  });

  it('rejects an invalid key with a 422', async () => {
    const { fetcher } = fetcherReturning(401);
    await expect(resendProvider.healthCheck({ api_key: 'bad' }, fetcher)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rejects a missing api_key without a network call', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(resendProvider.healthCheck({}, fetcher)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });
});
