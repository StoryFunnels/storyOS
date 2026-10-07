import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { openaiProvider } from './openai';
import type { ConnectionFetcher } from './types';

function fetcherReturning(status: number) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, json: async () => ({}), text: async () => '' };
  };
  return { fetcher, calls };
}

describe('openaiProvider.healthCheck (#352)', () => {
  it('accepts a valid key (200 from /v1/models)', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(openaiProvider.healthCheck({ api_key: 'sk-test-123' }, fetcher)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]!.headers?.authorization).toBe('Bearer sk-test-123');
  });

  it('rejects an invalid key with a 422', async () => {
    const { fetcher } = fetcherReturning(401);
    await expect(openaiProvider.healthCheck({ api_key: 'bad' }, fetcher)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rejects a missing api_key without a network call', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    await expect(openaiProvider.healthCheck({}, fetcher)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });

  it('is tier api_key — works identically on hosted and self-managed, no operator env needed', () => {
    expect(openaiProvider.tier).toBe('api_key');
  });
});
