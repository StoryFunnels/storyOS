import { describe, expect, it } from 'vitest';
import {
  RELATION_KEY_FIELD,
  SHOPIFY_CATALOGUE,
  catalogueDef,
  linkSetEqual,
  parseGid,
  parseGidList,
  resolveGids,
} from './shopify-catalogue';
import { mapCollection, mapProduct, mapVariant } from '../sources/providers/shopify';

describe('parseGidList', () => {
  it('splits a comma-joined GID list, trimming and de-duping', () => {
    expect(parseGidList('gid://shopify/Product/1, gid://shopify/Product/2')).toEqual([
      'gid://shopify/Product/1',
      'gid://shopify/Product/2',
    ]);
    expect(parseGidList('gid://shopify/Product/1, gid://shopify/Product/1')).toEqual([
      'gid://shopify/Product/1',
    ]);
  });
  it('handles a single GID, empties and non-strings', () => {
    expect(parseGidList('gid://shopify/Product/9')).toEqual(['gid://shopify/Product/9']);
    expect(parseGidList('')).toEqual([]);
    expect(parseGidList(null)).toEqual([]);
    expect(parseGidList(undefined)).toEqual([]);
    expect(parseGidList(', ,')).toEqual([]);
  });
});

describe('parseGid', () => {
  it('trims a single GID and nulls empties/non-strings', () => {
    expect(parseGid(' gid://shopify/Product/1 ')).toBe('gid://shopify/Product/1');
    expect(parseGid('')).toBeNull();
    expect(parseGid(null)).toBeNull();
    expect(parseGid(42)).toBeNull();
  });
});

describe('resolveGids', () => {
  const products = new Map([
    ['gid://shopify/Product/1', 'rec-1'],
    ['gid://shopify/Product/2', 'rec-2'],
  ]);
  it('resolves known GIDs to record ids, dropping unknown (order-independence)', () => {
    expect(
      resolveGids(['gid://shopify/Product/1', 'gid://shopify/Product/404', 'gid://shopify/Product/2'], products),
    ).toEqual(['rec-1', 'rec-2']);
  });
  it('de-dupes resolved ids and is empty when nothing resolves', () => {
    expect(resolveGids(['gid://shopify/Product/1', 'gid://shopify/Product/1'], products)).toEqual(['rec-1']);
    expect(resolveGids(['gid://shopify/Product/999'], products)).toEqual([]);
  });
});

describe('linkSetEqual', () => {
  it('is true for equal sets regardless of order (idempotency guard)', () => {
    expect(linkSetEqual(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(linkSetEqual([], [])).toBe(true);
  });
  it('is false when membership differs', () => {
    expect(linkSetEqual(['a'], ['a', 'b'])).toBe(false);
    expect(linkSetEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('catalogue shape stays aligned with the shopify providers', () => {
  it('every provider-emitted key has a catalogue field (so mapping is 1:1)', () => {
    const productKeys = Object.keys(mapProduct('acme.myshopify.com', { id: 'gid://shopify/Product/1' }));
    const variantKeys = Object.keys(mapVariant('acme.myshopify.com', { id: 'gid://shopify/ProductVariant/1' }));
    const collectionKeys = Object.keys(mapCollection('acme.myshopify.com', { id: 'gid://shopify/Collection/1' }));

    const has = (role: 'products' | 'variants' | 'collections', keys: string[]) => {
      const defined = new Set(catalogueDef(role).fields.map((f) => f.external_key));
      for (const key of keys) expect(defined, `${role} missing field for "${key}"`).toContain(key);
    };
    has('products', productKeys);
    has('variants', variantKeys);
    has('collections', collectionKeys);
  });

  it('each database has exactly one external-key field and one Name mapping', () => {
    for (const def of SHOPIFY_CATALOGUE) {
      expect(def.fields.filter((f) => f.is_key), `${def.role} key`).toHaveLength(1);
      expect(def.fields.filter((f) => f.to_name), `${def.role} name`).toHaveLength(1);
    }
  });

  it('the relation foreign keys are real fields on their databases', () => {
    const variantKeys = new Set(catalogueDef('variants').fields.map((f) => f.external_key));
    const collectionKeys = new Set(catalogueDef('collections').fields.map((f) => f.external_key));
    expect(variantKeys).toContain(RELATION_KEY_FIELD.variants);
    expect(collectionKeys).toContain(RELATION_KEY_FIELD.collections);
  });
});
