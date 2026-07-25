import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { normalizeShopDomain, shopifyProvider } from './shopify';
import type { ConnectionFetcher } from './types';

/** Routes canned GraphQL responses; records the URL + headers + parsed body of
 * each call so tests can assert the token header and where it was sent. */
function fakeFetcher(responder: (body: { query: string }) => { status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; headers?: Record<string, string>; body: { query: string } }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as { query: string };
    calls.push({ url, headers: init.headers, body });
    const r = responder(body);
    return { status: r.status ?? 200, json: async () => r.json ?? {}, text: async () => r.text ?? '' };
  };
  return { fetcher, calls };
}

describe('normalizeShopDomain', () => {
  it('accepts and canonicalizes the myshopify forms', () => {
    expect(normalizeShopDomain('acme.myshopify.com')).toBe('acme.myshopify.com');
    expect(normalizeShopDomain('ACME.myshopify.com')).toBe('acme.myshopify.com');
    expect(normalizeShopDomain('acme')).toBe('acme.myshopify.com');
    expect(normalizeShopDomain('https://acme.myshopify.com/admin')).toBe('acme.myshopify.com');
  });

  it('rejects non-myshopify hosts (SSRF guard)', () => {
    for (const bad of ['', 'internal.local', 'https://169.254.169.254/latest', 'acme.example.com']) {
      expect(() => normalizeShopDomain(bad)).toThrow(UnprocessableEntityException);
    }
  });
});

describe('shopifyProvider.healthCheck', () => {
  it('accepts a token whose { shop { name } } resolves', async () => {
    const { fetcher, calls } = fakeFetcher(() => ({ json: { data: { shop: { name: 'Acme' } } } }));
    await expect(
      shopifyProvider.healthCheck({ shop_domain: 'acme.myshopify.com', access_token: 'shpat_123' }, fetcher),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://acme.myshopify.com/admin/api/2024-07/graphql.json');
    expect(calls[0]!.headers?.['X-Shopify-Access-Token']).toBe('shpat_123');
  });

  it('rejects a 401 (bad/revoked token) with a 422', async () => {
    const { fetcher } = fakeFetcher(() => ({ status: 401 }));
    await expect(
      shopifyProvider.healthCheck({ shop_domain: 'acme.myshopify.com', access_token: 'bad' }, fetcher),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a GraphQL errors[] body even on HTTP 200', async () => {
    const { fetcher } = fakeFetcher(() => ({ json: { errors: [{ message: 'Throttled' }] } }));
    await expect(
      shopifyProvider.healthCheck({ shop_domain: 'acme.myshopify.com', access_token: 'shpat_123' }, fetcher),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a malformed shop domain without any network call', async () => {
    const { fetcher, calls } = fakeFetcher(() => ({ json: { data: { shop: { name: 'Acme' } } } }));
    await expect(
      shopifyProvider.healthCheck({ shop_domain: 'evil.example.com', access_token: 'shpat_123' }, fetcher),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing access token without a network call', async () => {
    const { fetcher, calls } = fakeFetcher(() => ({ json: { data: { shop: { name: 'Acme' } } } }));
    await expect(
      shopifyProvider.healthCheck({ shop_domain: 'acme.myshopify.com' }, fetcher),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });
});

describe('shopifyProvider.resolveScopes', () => {
  it('maps granted access scopes to scope:<handle> entries', async () => {
    const { fetcher } = fakeFetcher(() => ({
      json: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }] } } },
    }));
    const scopes = await shopifyProvider.resolveScopes!(
      { shop_domain: 'acme.myshopify.com', access_token: 'shpat_123' },
      fetcher,
    );
    expect(scopes).toEqual(['scope:read_products', 'scope:read_inventory']);
  });

  it('degrades to [] (never throws) when the scope read fails', async () => {
    const { fetcher } = fakeFetcher(() => ({ status: 500, text: 'boom' }));
    await expect(
      shopifyProvider.resolveScopes!({ shop_domain: 'acme.myshopify.com', access_token: 'shpat_123' }, fetcher),
    ).resolves.toEqual([]);
  });
});
