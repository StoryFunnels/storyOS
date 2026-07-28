import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mapCollectionWebhook,
  mapProductWebhook,
  routeTopic,
  verifyShopifyHmac,
  SHOPIFY_WEBHOOK_TOPICS,
} from './shopify-webhook';

const SECRET = 'shpss_test_secret';
const sign = (body: string) => createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');

describe('verifyShopifyHmac', () => {
  it('accepts a base64 HMAC-SHA256 of the raw body under the app secret', () => {
    const body = JSON.stringify({ id: 1, title: 'T' });
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), SECRET, sign(body))).toBe(true);
  });

  it('rejects when the body was tampered after signing (HMAC is over the wire bytes)', () => {
    const original = JSON.stringify({ id: 1, title: 'T' });
    const header = sign(original);
    const tampered = JSON.stringify({ id: 1, title: 'HACKED' });
    expect(verifyShopifyHmac(Buffer.from(tampered, 'utf8'), SECRET, header)).toBe(false);
  });

  it('rejects a wrong secret, an empty secret and an empty header', () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), 'other', sign(body))).toBe(false);
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), '', sign(body))).toBe(false);
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), SECRET, '')).toBe(false);
  });
});

describe('routeTopic', () => {
  it('maps every handled topic and rejects the rest', () => {
    expect(routeTopic('products/create')).toEqual({ role: 'products', action: 'upsert' });
    expect(routeTopic('products/update')).toEqual({ role: 'products', action: 'upsert' });
    expect(routeTopic('products/delete')).toEqual({ role: 'products', action: 'delete' });
    expect(routeTopic('collections/create')).toEqual({ role: 'collections', action: 'upsert' });
    expect(routeTopic('collections/update')).toEqual({ role: 'collections', action: 'upsert' });
    expect(routeTopic('collections/delete')).toEqual({ role: 'collections', action: 'delete' });
    expect(routeTopic('orders/create')).toBeNull();
    expect(routeTopic('app/uninstalled')).toBeNull();
    expect(routeTopic(undefined)).toBeNull();
  });

  it('every declared registration topic routes', () => {
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) expect(routeTopic(topic)).not.toBeNull();
  });
});

describe('mapProductWebhook — converges with the GraphQL sync shape (GID-keyed)', () => {
  it('reconstructs the product GID and emits nested variants keyed by their GID + parent GID', () => {
    const { product, variants } = mapProductWebhook('acme.myshopify.com', {
      id: 111,
      title: 'Wool Hat',
      handle: 'wool-hat',
      status: 'active',
      vendor: 'Acme',
      product_type: 'Hats',
      tags: 'winter, wool',
      image: { src: 'https://cdn/x.png' },
      images: [{ src: 'https://cdn/x.png' }, { src: 'https://cdn/y.png' }],
      variants: [
        { id: 900, product_id: 111, title: 'Small', sku: 'WH-S', price: '19.99', inventory_quantity: 3 },
        { id: 901, product_id: 111, title: 'Large', sku: 'WH-L', price: '19.99', inventory_quantity: 2 },
      ],
    });

    // Same immutable GID the GraphQL products sync stores → the upsert converges.
    expect(product?.product_id).toBe('gid://shopify/Product/111');
    expect(product?.title).toBe('Wool Hat');
    expect(product?.tags).toBe('winter, wool');
    expect(product?.inventory_total).toBe(5); // summed from variants
    expect(product?.image_url).toBe('https://cdn/x.png');
    expect(product?.image_urls).toBe('https://cdn/x.png, https://cdn/y.png');
    expect(product?.admin_url).toBe('https://acme.myshopify.com/admin/products/111');

    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({
      variant_id: 'gid://shopify/ProductVariant/900',
      product_id: 'gid://shopify/Product/111', // parent FK the relation materializes from
      sku: 'WH-S',
    });
    expect(variants[0]?.admin_url).toBe('https://acme.myshopify.com/admin/products/111/variants/900');
  });

  it('prefers an explicit admin_graphql_api_id when Shopify sends it', () => {
    const { product } = mapProductWebhook('acme.myshopify.com', {
      id: 111,
      admin_graphql_api_id: 'gid://shopify/Product/111',
      title: 'X',
      variants: [],
    });
    expect(product?.product_id).toBe('gid://shopify/Product/111');
  });

  it('nulls out cleanly with no id (nothing to key on)', () => {
    const { product, variants } = mapProductWebhook('acme.myshopify.com', { title: 'no id' });
    expect(product).toBeNull();
    expect(variants).toEqual([]);
  });

  it('omits product_ids-style fields absent from a push so the scheduled sync value survives', () => {
    const { product } = mapProductWebhook('acme.myshopify.com', { id: 5, title: 'Y', variants: [] });
    // storefront_url / products_count are not webhook fields → absent from the item,
    // so upsertBatch (skips undefined) never clobbers a scheduled-sync value.
    expect(product && 'storefront_url' in product).toBe(false);
    expect(product?.inventory_total).toBeNull();
  });
});

describe('mapCollectionWebhook', () => {
  it('maps scalar collection fields, keyed by the collection GID, and omits member list', () => {
    const collection = mapCollectionWebhook('acme.myshopify.com', {
      id: 5,
      title: 'Summer',
      handle: 'summer',
      body_html: '<p>Hot</p>',
    });
    expect(collection).toMatchObject({
      collection_id: 'gid://shopify/Collection/5',
      title: 'Summer',
      handle: 'summer',
      description: '<p>Hot</p>',
      admin_url: 'https://acme.myshopify.com/admin/collections/5',
    });
    // product_ids intentionally absent (webhook payload has no member list) so a
    // push never wipes the membership the scheduled collections sync materializes.
    expect(collection && 'product_ids' in collection).toBe(false);
  });
});
