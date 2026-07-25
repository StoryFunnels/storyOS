import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  mapCollection,
  mapProduct,
  mapVariant,
  shopifyCollectionsProvider,
  shopifyProductsProvider,
  shopifyVariantsProvider,
} from './shopify';
import type { SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

const AUTH = { shop_domain: 'acme.myshopify.com', access_token: 'shpat_123' };

/** A GraphQL fetcher that returns queued page bodies in order (one per POST),
 * or a single body repeated. Each body is `{ data: … }` unless a status/errors
 * override is given. Records the parsed request bodies for cursor assertions. */
function graphqlFetcher(pages: unknown[]): { fetcher: ConnectionFetcher; requests: Array<{ query: string; variables?: Record<string, unknown> }> } {
  const requests: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let i = 0;
  const fetcher: ConnectionFetcher = async (_url, init) => {
    requests.push(JSON.parse(init.body ?? '{}'));
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { status: 200, json: async () => body, text: async () => '' };
  };
  return { fetcher, requests };
}

function baseCtx(overrides: Partial<SourceSyncContext> = {}): SourceSyncContext {
  return {
    auth: AUTH,
    config: {},
    cursor: {},
    fetcher: async () => {
      throw new Error('fetcher not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

// ── pure mapping ────────────────────────────────────────────────────────────

describe('mapProduct', () => {
  it('maps all catalogue fields and both admin + storefront URLs', () => {
    expect(
      mapProduct('acme.myshopify.com', {
        id: 'gid://shopify/Product/111',
        legacyResourceId: '111',
        title: 'Wool Hat',
        handle: 'wool-hat',
        status: 'ACTIVE',
        vendor: 'Acme',
        productType: 'Hats',
        tags: ['warm', 'winter'],
        totalInventory: 42,
        onlineStoreUrl: 'https://acme.com/products/wool-hat',
        featuredImage: { url: 'https://cdn/one.jpg' },
        images: { nodes: [{ url: 'https://cdn/one.jpg' }, { url: 'https://cdn/two.jpg' }] },
      }),
    ).toEqual({
      product_id: 'gid://shopify/Product/111',
      title: 'Wool Hat',
      handle: 'wool-hat',
      status: 'ACTIVE',
      vendor: 'Acme',
      product_type: 'Hats',
      tags: 'warm, winter',
      inventory_total: 42,
      image_url: 'https://cdn/one.jpg',
      image_urls: 'https://cdn/one.jpg, https://cdn/two.jpg',
      storefront_url: 'https://acme.com/products/wool-hat',
      admin_url: 'https://acme.myshopify.com/admin/products/111',
    });
  });

  it('surfaces an ARCHIVED product (never drops it) and tolerates missing optionals', () => {
    const row = mapProduct('acme.myshopify.com', {
      id: 'gid://shopify/Product/222',
      status: 'ARCHIVED',
    });
    expect(row['status']).toBe('ARCHIVED');
    expect(row['product_id']).toBe('gid://shopify/Product/222');
    expect(row['image_url']).toBeNull();
    expect(row['admin_url']).toBeNull();
  });
});

describe('mapVariant', () => {
  it('keeps the parent product GID (relationship) + prices + inventory', () => {
    expect(
      mapVariant('acme.myshopify.com', {
        id: 'gid://shopify/ProductVariant/900',
        legacyResourceId: '900',
        title: 'S',
        sku: 'HAT-S',
        price: '19.99',
        compareAtPrice: '24.99',
        inventoryQuantity: 7,
        product: { id: 'gid://shopify/Product/111', legacyResourceId: '111' },
      }),
    ).toEqual({
      variant_id: 'gid://shopify/ProductVariant/900',
      product_id: 'gid://shopify/Product/111',
      title: 'S',
      sku: 'HAT-S',
      price: '19.99',
      compare_at_price: '24.99',
      inventory_quantity: 7,
      admin_url: 'https://acme.myshopify.com/admin/products/111/variants/900',
    });
  });
});

describe('mapCollection', () => {
  it('keeps member product GIDs (relationship) and handles the {count} shape', () => {
    const row = mapCollection('acme.myshopify.com', {
      id: 'gid://shopify/Collection/5',
      legacyResourceId: '5',
      title: 'Winter',
      handle: 'winter',
      productsCount: { count: 2 },
      products: { nodes: [{ id: 'gid://shopify/Product/111' }, { id: 'gid://shopify/Product/222' }] },
    });
    expect(row).toMatchObject({
      collection_id: 'gid://shopify/Collection/5',
      products_count: 2,
      product_ids: 'gid://shopify/Product/111, gid://shopify/Product/222',
      admin_url: 'https://acme.myshopify.com/admin/collections/5',
    });
  });
});

// ── sync: initial import, pagination, idempotent re-sync ─────────────────────

describe('shopifyProductsProvider.sync', () => {
  it('emits upsert-ready product rows keyed by the immutable Shopify GID', async () => {
    const { fetcher } = graphqlFetcher([
      {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: 'c1' },
            nodes: [
              { id: 'gid://shopify/Product/111', legacyResourceId: '111', title: 'Hat', status: 'ACTIVE' },
              { id: 'gid://shopify/Product/222', legacyResourceId: '222', title: 'Scarf', status: 'DRAFT' },
            ],
          },
        },
      },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    const result = await shopifyProductsProvider.sync(baseCtx({ fetcher, emit: async (i) => void emitted.push(...i) }));
    expect(emitted.map((r) => r['product_id'])).toEqual(['gid://shopify/Product/111', 'gid://shopify/Product/222']);
    // Walk complete → cursor cleared so the next run re-syncs from the top.
    expect(result.cursor).toEqual({ after: null });
    expect(result.stats).toMatchObject({ emitted: 2, complete: true });
  });

  it('walks pages, passing endCursor as the next `cursor` variable', async () => {
    const { fetcher, requests } = graphqlFetcher([
      { data: { products: { pageInfo: { hasNextPage: true, endCursor: 'cursorA' }, nodes: [{ id: 'gid://shopify/Product/1' }] } } },
      { data: { products: { pageInfo: { hasNextPage: false, endCursor: 'cursorB' }, nodes: [{ id: 'gid://shopify/Product/2' }] } } },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    const result = await shopifyProductsProvider.sync(baseCtx({ fetcher, emit: async (i) => void emitted.push(...i) }));
    expect(emitted.map((r) => r['product_id'])).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2']);
    expect(requests[0]!.variables).toEqual({ cursor: null });
    expect(requests[1]!.variables).toEqual({ cursor: 'cursorA' });
    expect(result.cursor).toEqual({ after: null });
  });

  it('resumes from the stored `after` cursor and re-emits stable ids (idempotent upsert)', async () => {
    // A resumed tick starts from cursor.after; re-syncing later re-emits the
    // same GIDs — the engine upserts by external key, so no duplicates.
    const { fetcher, requests } = graphqlFetcher([
      { data: { products: { pageInfo: { hasNextPage: false, endCursor: 'z' }, nodes: [{ id: 'gid://shopify/Product/111' }] } } },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await shopifyProductsProvider.sync(
      baseCtx({ fetcher, cursor: { after: 'resume-here' }, emit: async (i) => void emitted.push(...i) }),
    );
    expect(requests[0]!.variables).toEqual({ cursor: 'resume-here' });
    expect(emitted[0]!['product_id']).toBe('gid://shopify/Product/111');
  });

  it('propagates a GraphQL error body as a thrown 422 (run recorded as error, cursor untouched)', async () => {
    const { fetcher } = graphqlFetcher([{ errors: [{ message: 'Throttled' }] }]);
    await expect(shopifyProductsProvider.sync(baseCtx({ fetcher }))).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('shopifyVariantsProvider.sync', () => {
  it('emits variants each carrying their parent product GID', async () => {
    const { fetcher } = graphqlFetcher([
      {
        data: {
          productVariants: {
            pageInfo: { hasNextPage: false, endCursor: 'c' },
            nodes: [
              { id: 'gid://shopify/ProductVariant/900', legacyResourceId: '900', sku: 'A', product: { id: 'gid://shopify/Product/111', legacyResourceId: '111' } },
            ],
          },
        },
      },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await shopifyVariantsProvider.sync(baseCtx({ fetcher, emit: async (i) => void emitted.push(...i) }));
    expect(emitted[0]).toMatchObject({ variant_id: 'gid://shopify/ProductVariant/900', product_id: 'gid://shopify/Product/111' });
  });
});

describe('shopifyCollectionsProvider.sync', () => {
  it('emits collections with member product GIDs', async () => {
    const { fetcher } = graphqlFetcher([
      {
        data: {
          collections: {
            pageInfo: { hasNextPage: false, endCursor: 'c' },
            nodes: [
              { id: 'gid://shopify/Collection/5', legacyResourceId: '5', title: 'Winter', productsCount: { count: 1 }, products: { nodes: [{ id: 'gid://shopify/Product/111' }] } },
            ],
          },
        },
      },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await shopifyCollectionsProvider.sync(baseCtx({ fetcher, emit: async (i) => void emitted.push(...i) }));
    expect(emitted[0]).toMatchObject({ collection_id: 'gid://shopify/Collection/5', product_ids: 'gid://shopify/Product/111' });
  });
});
