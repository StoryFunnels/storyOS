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

/** MN-256 — verified domains become `domain:` scopes; a configured
 * from_address must be on one of them or resolveScopes rejects it outright. */
describe('resendProvider.resolveScopes', () => {
  function domainsFetcher(domains: Array<{ name: string; status: string }>): ConnectionFetcher {
    return async () => ({
      status: 200,
      json: async () => ({ data: domains }),
      text: async () => '',
    });
  }

  it('returns domain: scopes for every verified domain', async () => {
    const fetcher = domainsFetcher([
      { name: 'example.com', status: 'verified' },
      { name: 'pending.example.com', status: 'pending' },
    ]);
    const scopes = await resendProvider.resolveScopes!({ api_key: 're_test' }, fetcher);
    expect(scopes).toEqual(['domain:example.com']);
  });

  it('adds a from: scope when from_address is on a verified domain', async () => {
    const fetcher = domainsFetcher([{ name: 'example.com', status: 'verified' }]);
    const scopes = await resendProvider.resolveScopes!(
      { api_key: 're_test', from_address: 'automations@example.com' },
      fetcher,
    );
    expect(scopes).toEqual(['domain:example.com', 'from:automations@example.com']);
  });

  it('rejects a from_address whose domain is not verified on this key', async () => {
    const fetcher = domainsFetcher([{ name: 'example.com', status: 'verified' }]);
    await expect(
      resendProvider.resolveScopes!({ api_key: 're_test', from_address: 'a@other.com' }, fetcher),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns [] without a network call when api_key is missing', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    const scopes = await resendProvider.resolveScopes!({}, fetcher);
    expect(scopes).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
