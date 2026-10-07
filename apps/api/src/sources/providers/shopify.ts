import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { shopifyGraphql } from '../../connections/providers/shopify';
import type { ShopifyAuth } from '../../connections/providers/shopify';
import type { PushResult, SourceProviderDescriptor, SourcePushContext, SourceSyncContext } from './types';

/**
 * #333 — the Shopify **product-catalogue** source: three read providers that
 * upsert a store's Products, Variants and Collections into StoryOS databases,
 * keyed by their immutable Shopify GID so a re-sync UPSERTs (never duplicates)
 * and a human's own edits to unmapped fields survive every resync (the engine's
 * invariant, sources.service.ts).
 *
 * All three ride the `shopify` connection (Tier A: the merchant's own Admin API
 * access token) and talk to the **GraphQL** Admin API. GraphQL — not REST — on
 * purpose: cursor pagination lives in the JSON body (`pageInfo.endCursor`),
 * which the connection fetcher seam can carry, whereas REST's `Link` header
 * cannot be read through that seam (and so couldn't be tested with the injected
 * fetcher every source test uses).
 *
 * Each provider walks the whole collection from the start, bounded to
 * MAX_PAGES_PER_TICK pages per scheduler tick and resuming from the stored
 * `after` cursor next tick (exactly youtube.videos' resumable full-walk shape);
 * when `hasNextPage` runs out it clears the cursor so the next run starts fresh
 * and re-syncs the catalogue — that's the continuous, idempotent sync.
 *
 * Relationships are preserved as the counterpart's immutable Shopify GID on
 * each row (`product_id` on a variant, `product_ids` on a collection). #110's
 * `ShopifyCatalogueService` turns those foreign keys into materialized StoryOS
 * *relation fields*: an external-key→record-id resolution pass (keyed by the
 * stored GID, so idempotent + order-independent) writes the product↔variant and
 * product↔collection links as records sync in. The GID text stays on each row —
 * it's the immutable key the resolution is driven from.
 *
 * Deletion semantics follow the framework: the GraphQL walk simply stops
 * returning a product that was deleted in Shopify, and the engine leaves that
 * record intact (same "credential/source gone, history stays" philosophy).
 * ARCHIVED / DRAFT products are surfaced via the `status` field rather than
 * dropped, so a view can filter them.
 */

/** Pages fetched within one sync() call before yielding to the next tick —
 * bounds one source's worst-case time inside the shared 60s scheduler pass,
 * same reasoning as youtube.ts's MAX_PAGES / apify.ts's per-tick page cap. */
const MAX_PAGES_PER_TICK = 20;

/** No per-entity config today — a catalogue source syncs the whole store. Kept
 * as an (empty) object schema so the generic config-form + safeParse paths in
 * SourcesService treat it like every other provider. */
const catalogueConfigSchema = z.object({});

function authOf(auth: unknown): ShopifyAuth {
  const { shop_domain, access_token } = (auth ?? {}) as Partial<ShopifyAuth>;
  return { shop_domain: shop_domain ?? '', access_token: access_token ?? '' };
}

/** Shopify's `productsCount`/`productsCount { count }` shifted shape across API
 * versions; accept a bare number or a `{ count }` object either way. */
function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  const count = (value as { count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : 0;
}

function tagsOf(value: unknown): string {
  return Array.isArray(value) ? value.map((t) => String(t)).join(', ') : '';
}

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

/** Run one bounded, resumable walk of a top-level connection field, emitting a
 * mapped batch per page. Returns the next cursor: `{ after: endCursor }` while
 * more pages remain this catalogue, or `{ after: null }` once the walk
 * completes (so the next scheduler run re-syncs from the top). */
async function walkConnection<TNode>(
  ctx: SourceSyncContext,
  query: string,
  pick: (data: Record<string, unknown>) => { nodes: TNode[]; pageInfo: PageInfo },
  map: (node: TNode) => Record<string, unknown>,
): Promise<{ cursor: Record<string, unknown>; stats: Record<string, unknown> }> {
  const auth = authOf(ctx.auth);
  let after = (ctx.cursor['after'] as string | undefined) ?? undefined;
  let pagesWalked = 0;
  let emitted = 0;
  // Assigned on the first (guaranteed) do-while iteration before it's ever read.
  let hasNextPage: boolean;

  do {
    const data = await shopifyGraphql<Record<string, unknown>>(ctx.fetcher, auth, query, { cursor: after ?? null });
    const { nodes, pageInfo } = pick(data);
    if (nodes.length) {
      await ctx.emit(nodes.map(map));
      emitted += nodes.length;
    }
    hasNextPage = Boolean(pageInfo.hasNextPage);
    after = pageInfo.endCursor ?? undefined;
    pagesWalked += 1;
  } while (hasNextPage && after && pagesWalked < MAX_PAGES_PER_TICK);

  // More pages remain → resume from `after` next tick. Walk complete → clear
  // the cursor so the next run re-syncs the whole catalogue from the top.
  const cursor = hasNextPage && after ? { after } : { after: null };
  return { cursor, stats: { emitted, pages: pagesWalked, complete: !hasNextPage } };
}

// ── field mapping (pure, unit-tested) ───────────────────────────────────────

interface ProductNode {
  id: string;
  legacyResourceId?: string | null;
  title?: string | null;
  handle?: string | null;
  status?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  totalInventory?: number | null;
  onlineStoreUrl?: string | null;
  featuredImage?: { url?: string | null } | null;
  images?: { nodes?: Array<{ url?: string | null }> } | null;
}

export function mapProduct(shopDomain: string, node: ProductNode): Record<string, unknown> {
  const imageUrls = (node.images?.nodes ?? []).map((i) => i?.url).filter((u): u is string => Boolean(u));
  return {
    product_id: node.id,
    title: node.title ?? '',
    handle: node.handle ?? '',
    status: node.status ?? null,
    vendor: node.vendor ?? '',
    product_type: node.productType ?? '',
    tags: tagsOf(node.tags),
    inventory_total: node.totalInventory ?? null,
    image_url: node.featuredImage?.url ?? imageUrls[0] ?? null,
    image_urls: imageUrls.join(', '),
    storefront_url: node.onlineStoreUrl ?? null,
    admin_url: node.legacyResourceId ? `https://${shopDomain}/admin/products/${node.legacyResourceId}` : null,
  };
}

interface VariantNode {
  id: string;
  legacyResourceId?: string | null;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  product?: { id?: string | null; legacyResourceId?: string | null } | null;
}

export function mapVariant(shopDomain: string, node: VariantNode): Record<string, unknown> {
  const productLegacy = node.product?.legacyResourceId;
  const variantLegacy = node.legacyResourceId;
  return {
    variant_id: node.id,
    // Immutable Shopify GID of the parent product — preserves the
    // product↔variant relationship as a foreign key.
    product_id: node.product?.id ?? null,
    title: node.title ?? '',
    sku: node.sku ?? '',
    price: node.price ?? null,
    compare_at_price: node.compareAtPrice ?? null,
    inventory_quantity: node.inventoryQuantity ?? null,
    admin_url:
      productLegacy && variantLegacy
        ? `https://${shopDomain}/admin/products/${productLegacy}/variants/${variantLegacy}`
        : null,
  };
}

interface CollectionNode {
  id: string;
  legacyResourceId?: string | null;
  title?: string | null;
  handle?: string | null;
  description?: string | null;
  productsCount?: unknown;
  products?: { nodes?: Array<{ id?: string | null }> } | null;
}

export function mapCollection(shopDomain: string, node: CollectionNode): Record<string, unknown> {
  const productIds = (node.products?.nodes ?? []).map((p) => p?.id).filter((id): id is string => Boolean(id));
  return {
    collection_id: node.id,
    title: node.title ?? '',
    handle: node.handle ?? '',
    description: node.description ?? '',
    products_count: countOf(node.productsCount),
    // Member products' immutable Shopify GIDs — preserves the
    // product↔collection relationship as a foreign-key list.
    product_ids: productIds.join(', '),
    admin_url: node.legacyResourceId ? `https://${shopDomain}/admin/collections/${node.legacyResourceId}` : null,
  };
}

// ── GraphQL documents ───────────────────────────────────────────────────────

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: 50, after: $cursor, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId title handle status vendor productType tags totalInventory onlineStoreUrl
      featuredImage { url }
      images(first: 10) { nodes { url } }
    }
  }
}`;

const VARIANTS_QUERY = `query Variants($cursor: String) {
  productVariants(first: 100, after: $cursor, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId title sku price compareAtPrice inventoryQuantity
      product { id legacyResourceId }
    }
  }
}`;

const COLLECTIONS_QUERY = `query Collections($cursor: String) {
  collections(first: 50, after: $cursor, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId title handle description
      productsCount { count }
      products(first: 100) { nodes { id } }
    }
  }
}`;

// ── write-back (#281, product scalars only — see the module doc for why) ───

const PRODUCT_UPDATE_MUTATION = `mutation ProductUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id }
    userErrors { field message }
  }
}`;

/**
 * #281 — the pushable product scalars, mapProduct()'s external keys minus the
 * ones that are read-only/computed on Shopify's side (product_id, handle,
 * inventory_total, image_url(s), storefront_url, admin_url). Variant/price
 * write-back is explicitly a follow-up (#281's AC) — a different Shopify
 * resource (`productVariants`), not something this mutation can reach.
 */
const PUSHABLE_PRODUCT_KEYS = new Set(['title', 'status', 'vendor', 'product_type', 'tags']);

/** `values` (external-key-keyed, per SourcePushContext's contract) → Shopify's
 * `ProductInput` shape. `tags` round-trips through the same comma-joined
 * string `mapProduct`/`tagsOf` store it as on the pull side — split back into
 * the array Shopify's input expects. Anything outside PUSHABLE_PRODUCT_KEYS is
 * silently ignored rather than erroring: `values` is engine-controlled
 * (WriteBackSubscriber only sends `out`/`both`-mapped, changed keys), so an
 * unrecognized key here would mean a future mapping addition, not caller error. */
function productInputFrom(externalKey: string, values: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { id: externalKey };
  for (const [key, value] of Object.entries(values)) {
    if (!PUSHABLE_PRODUCT_KEYS.has(key)) continue;
    if (key === 'tags') {
      input.tags = typeof value === 'string' ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
    } else if (key === 'product_type') {
      input.productType = value ?? '';
    } else {
      input[key] = value ?? '';
    }
  }
  return input;
}

async function pushProduct(ctx: SourcePushContext): Promise<PushResult> {
  const auth = authOf(ctx.auth);
  const input = productInputFrom(ctx.externalKey, ctx.values);
  const data = await shopifyGraphql<{
    productUpdate: { product: { id: string } | null; userErrors: Array<{ field?: string[]; message: string }> };
  }>(ctx.fetcher, auth, PRODUCT_UPDATE_MUTATION, { input });
  const errors = data.productUpdate?.userErrors ?? [];
  // Shopify answers 200 with userErrors for a REJECTED mutation (bad status
  // value, invalid tag, etc) — shopifyGraphql only inspects top-level
  // `errors`, so this body-level array must be checked here too, exactly the
  // same "200 doesn't mean success" lesson shopifyGraphql itself documents.
  if (errors.length > 0) {
    throw new UnprocessableEntityException(
      `Shopify rejected the product update: ${errors.map((e) => e.message).filter(Boolean).join('; ') || 'unknown error'}`,
    );
  }
  return { stats: { shopify_product_id: data.productUpdate?.product?.id ?? ctx.externalKey } };
}

// ── providers ───────────────────────────────────────────────────────────────

/** Resolve the store host once per sync so mapped admin/storefront URLs are
 * correct — the auth carries it, already validated by the connection. */
function shopDomainOf(ctx: SourceSyncContext): string {
  return authOf(ctx.auth).shop_domain;
}

export const shopifyProductsProvider: SourceProviderDescriptor = {
  id: 'shopify.products',
  icon: 'brand:shopify',
  label: 'Shopify — products',
  connectionProvider: 'shopify',
  configSchema: catalogueConfigSchema,
  description: 'Products from your Shopify store, keyed by their Shopify id — includes archived and draft products (via the status field).',
  estimateQuotaUnits: () => MAX_PAGES_PER_TICK,
  async sync(ctx: SourceSyncContext) {
    const shopDomain = shopDomainOf(ctx);
    return walkConnection<ProductNode>(
      ctx,
      PRODUCTS_QUERY,
      (data) => (data['products'] as { nodes: ProductNode[]; pageInfo: PageInfo }),
      (node) => mapProduct(shopDomain, node),
    );
  },
  // #281 — product scalars only (title/status/vendor/product_type/tags); see
  // PUSHABLE_PRODUCT_KEYS. Gated by `write_back` on the source itself (#279)
  // and by direction (#280) — this being defined is necessary, not sufficient.
  push: pushProduct,
};

export const shopifyVariantsProvider: SourceProviderDescriptor = {
  id: 'shopify.variants',
  icon: 'brand:shopify',
  label: 'Shopify — variants',
  connectionProvider: 'shopify',
  configSchema: catalogueConfigSchema,
  description: 'Product variants (SKU, price, inventory), each linked to its product by the product\'s Shopify id.',
  estimateQuotaUnits: () => MAX_PAGES_PER_TICK,
  async sync(ctx: SourceSyncContext) {
    const shopDomain = shopDomainOf(ctx);
    return walkConnection<VariantNode>(
      ctx,
      VARIANTS_QUERY,
      (data) => (data['productVariants'] as { nodes: VariantNode[]; pageInfo: PageInfo }),
      (node) => mapVariant(shopDomain, node),
    );
  },
};

export const shopifyCollectionsProvider: SourceProviderDescriptor = {
  id: 'shopify.collections',
  icon: 'brand:shopify',
  label: 'Shopify — collections',
  connectionProvider: 'shopify',
  configSchema: catalogueConfigSchema,
  description: 'Collections and their member products (custom and smart), keyed by their Shopify id.',
  estimateQuotaUnits: () => MAX_PAGES_PER_TICK,
  async sync(ctx: SourceSyncContext) {
    const shopDomain = shopDomainOf(ctx);
    return walkConnection<CollectionNode>(
      ctx,
      COLLECTIONS_QUERY,
      (data) => (data['collections'] as { nodes: CollectionNode[]; pageInfo: PageInfo }),
      (node) => mapCollection(shopDomain, node),
    );
  },
};

export { catalogueConfigSchema as shopifyCatalogueConfigSchema };
