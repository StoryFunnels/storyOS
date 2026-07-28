import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * #24 — Shopify real-time webhook sync, pure core (isolated from Nest + the DB
 * so it unit-tests cleanly, exactly like shopify-catalogue.ts).
 *
 * Two jobs live here as pure functions:
 *
 *  1. **HMAC verification** — Shopify signs every webhook with the app's API
 *     secret over the RAW request body, delivered base64 in the
 *     `X-Shopify-Hmac-Sha256` header. `verifyShopifyHmac` recomputes that MAC
 *     over the untouched wire bytes and timing-safe-compares. The route reads
 *     `req.rawBody` (app.setup.ts allowlist) so the bytes hashed are the bytes
 *     Shopify signed — a re-serialized body would silently accept tampering
 *     that survives a JSON round-trip.
 *
 *  2. **Payload → emit-shape mapping** — a webhook delivers Shopify's REST
 *     object shape (snake_case, numeric ids, variants nested in the product),
 *     whereas the scheduled sync walks the GraphQL Admin API (GID ids,
 *     camelCase). Both must converge to the SAME records, so these mappers
 *     produce the exact record shape the GraphQL mappers (sources/providers/
 *     shopify.ts) emit — crucially keyed by the SAME immutable Shopify GID
 *     (`product_id`/`variant_id`/`collection_id`), reconstructed from the
 *     payload's `admin_graphql_api_id` when present, else `gid://shopify/
 *     <Type>/<id>`. Feeding those into the shared upsert engine
 *     (SourcesService.ingestExternalItems) means a push and a scheduled tick
 *     for the same object UPSERT the one GID-keyed record instead of forking a
 *     second write path.
 */

/**
 * `X-Shopify-Hmac-Sha256` verification: base64 HMAC-SHA256 of the **raw request
 * body** under the app's API secret. `timingSafeEqual`, length-checked first
 * because it throws on a length mismatch (a throw is itself an oracle); the
 * length short-circuit is safe because the digest length is a public constant.
 */
export function verifyShopifyHmac(rawBody: Buffer, secret: string, header: string): boolean {
  if (!secret || !header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The catalogue role a webhook topic targets, plus whether it's a delete. */
export interface TopicRoute {
  role: 'products' | 'collections';
  action: 'upsert' | 'delete';
}

/**
 * Map a `X-Shopify-Topic` to what it means here. Products AND collections
 * create/update/delete are handled; variants arrive nested inside the product
 * payload, so there is no standalone variant topic. Any other topic (orders,
 * app/uninstalled, …) returns null — acknowledged, ignored.
 */
export function routeTopic(topic: string | undefined): TopicRoute | null {
  switch ((topic ?? '').trim().toLowerCase()) {
    case 'products/create':
    case 'products/update':
      return { role: 'products', action: 'upsert' };
    case 'products/delete':
      return { role: 'products', action: 'delete' };
    case 'collections/create':
    case 'collections/update':
      return { role: 'collections', action: 'upsert' };
    case 'collections/delete':
      return { role: 'collections', action: 'delete' };
    default:
      return null;
  }
}

/** The set of topics this receiver registers/handles — the registration list. */
export const SHOPIFY_WEBHOOK_TOPICS: readonly string[] = [
  'products/create',
  'products/update',
  'products/delete',
  'collections/create',
  'collections/update',
  'collections/delete',
];

/** `admin_graphql_api_id` when Shopify included it, else the constructed GID.
 * REST ids ARE the numeric legacy resource id, so `gid://shopify/<Type>/<id>`
 * reconstructs the exact GID the GraphQL sync stores. */
function gidOf(payload: Record<string, unknown>, type: 'Product' | 'ProductVariant' | 'Collection'): string | null {
  const explicit = payload['admin_graphql_api_id'];
  if (typeof explicit === 'string' && explicit.startsWith('gid://')) return explicit;
  const id = payload['id'];
  if (typeof id === 'number' || (typeof id === 'string' && id.trim())) return `gid://shopify/${type}/${id}`;
  return null;
}

/** REST `tags` is a comma-joined string; tolerate an array too (matches the
 * GraphQL mapper's tags join). */
function tagsOf(value: unknown): string {
  if (Array.isArray(value)) return value.map((t) => String(t)).join(', ');
  return typeof value === 'string' ? value : '';
}

function imageUrlsOf(payload: Record<string, unknown>): string[] {
  const images = payload['images'];
  const list = Array.isArray(images) ? images : [];
  return list
    .map((i) => (i as { src?: unknown } | null)?.src)
    .filter((u): u is string => typeof u === 'string' && Boolean(u));
}

interface WebhookVariant {
  id?: number | string;
  product_id?: number | string;
  admin_graphql_api_id?: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  inventory_quantity?: number | null;
}

/**
 * A products/* webhook payload → the product record item AND its variant
 * record items, both in the exact emit shape the GraphQL sync uses (shopify.ts
 * mapProduct/mapVariant). `product_id`/`variant_id` carry the same GIDs the
 * scheduled sync stores, so the upsert converges rather than duplicates.
 *
 * `storefront_url` and `products_count` aren't in the webhook payload — those
 * fields are simply omitted, and the shared upsert engine only writes fields
 * present in the item (it `continue`s on `undefined`), so any value the
 * scheduled sync stored for them survives untouched. `inventory_total` is
 * summed from the nested variants when present (the webhook payload has no
 * store-wide total field), else omitted.
 */
export function mapProductWebhook(
  shopDomain: string,
  payload: Record<string, unknown>,
): { product: Record<string, unknown> | null; variants: Array<Record<string, unknown>> } {
  const productGid = gidOf(payload, 'Product');
  if (!productGid) return { product: null, variants: [] };

  const id = payload['id'];
  const imageUrls = imageUrlsOf(payload);
  const featured = (payload['image'] as { src?: unknown } | null)?.src;
  const variantsRaw = Array.isArray(payload['variants']) ? (payload['variants'] as WebhookVariant[]) : [];

  let inventoryTotal: number | null = null;
  for (const v of variantsRaw) {
    if (typeof v.inventory_quantity === 'number') inventoryTotal = (inventoryTotal ?? 0) + v.inventory_quantity;
  }

  const product: Record<string, unknown> = {
    product_id: productGid,
    title: (payload['title'] as string) ?? '',
    handle: (payload['handle'] as string) ?? '',
    status: (payload['status'] as string) ?? null,
    vendor: (payload['vendor'] as string) ?? '',
    product_type: (payload['product_type'] as string) ?? '',
    tags: tagsOf(payload['tags']),
    inventory_total: inventoryTotal,
    image_url: (typeof featured === 'string' ? featured : undefined) ?? imageUrls[0] ?? null,
    image_urls: imageUrls.join(', '),
    admin_url: id !== undefined && id !== null ? `https://${shopDomain}/admin/products/${id}` : null,
  };

  const variants = variantsRaw
    .map((v) => mapVariantWebhook(shopDomain, productGid, id, v))
    .filter((v): v is Record<string, unknown> => v !== null);

  return { product, variants };
}

/** One nested variant → the variants emit shape (shopify.ts mapVariant), keyed
 * by the variant GID and carrying the parent product's GID as the foreign key
 * the product↔variant relation materializes from. */
export function mapVariantWebhook(
  shopDomain: string,
  productGid: string,
  productLegacyId: unknown,
  variant: WebhookVariant,
): Record<string, unknown> | null {
  const variantGid = gidOf(variant as Record<string, unknown>, 'ProductVariant');
  if (!variantGid) return null;
  const variantLegacy = variant.id;
  return {
    variant_id: variantGid,
    product_id: productGid,
    title: variant.title ?? '',
    sku: variant.sku ?? '',
    price: variant.price ?? null,
    compare_at_price: variant.compare_at_price ?? null,
    inventory_quantity: variant.inventory_quantity ?? null,
    admin_url:
      productLegacyId !== undefined && productLegacyId !== null && variantLegacy !== undefined && variantLegacy !== null
        ? `https://${shopDomain}/admin/products/${productLegacyId}/variants/${variantLegacy}`
        : null,
  };
}

/**
 * A collections/* webhook payload → the collection record item (shopify.ts
 * mapCollection shape), keyed by the collection GID.
 *
 * Deliberately omits `product_ids` (and `products_count`): the collections
 * webhook payload does NOT carry the member-product list, and the shared upsert
 * only writes fields present in the item — so a collection push updates
 * title/handle/description in real time while the membership the scheduled
 * `shopify.collections` sync materializes is preserved untouched. Membership
 * changes therefore converge on the next scheduled collections tick, not the
 * push — a documented, convergence-safe limitation rather than a second,
 * conflicting write path.
 */
export function mapCollectionWebhook(
  shopDomain: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const collectionGid = gidOf(payload, 'Collection');
  if (!collectionGid) return null;
  const id = payload['id'];
  const body = payload['body_html'];
  return {
    collection_id: collectionGid,
    title: (payload['title'] as string) ?? '',
    handle: (payload['handle'] as string) ?? '',
    description: typeof body === 'string' ? body : '',
    admin_url: id !== undefined && id !== null ? `https://${shopDomain}/admin/collections/${id}` : null,
  };
}
