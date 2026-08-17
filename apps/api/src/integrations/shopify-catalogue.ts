/**
 * #110 — the Shopify **product-catalogue** guided setup + relation
 * materialization, pure core (isolated from Nest + the DB so it unit-tests
 * cleanly, exactly like relations/auto-link.ts).
 *
 * Two jobs live here as pure data/functions:
 *
 *  1. The **catalogue shape** — the three databases (Products, Variants,
 *     Collections), their fields (aligned one-for-one with what the
 *     `shopify.*` source providers emit in sources/providers/shopify.ts so the
 *     source field-mapping is a trivial identity), and the two relations
 *     between them. `ShopifyCatalogueService.provision()` consumes this to
 *     create everything in one click.
 *
 *  2. **GID → record-id resolution** — the load-bearing part of #110. The
 *     source sync stores each Shopify object under its immutable GID and keeps
 *     the *counterpart's* GID as text (`product_id` on a variant, `product_ids`
 *     on a collection — shopify.ts). Turning that text into navigable StoryOS
 *     relation links means resolving those GIDs to the record ids the products
 *     source created, then writing `record_links`. Because the resolution is
 *     keyed by the immutable GID it is idempotent (re-resolving yields the same
 *     answer) and order-independent (a variant/collection that imported before
 *     its product simply resolves to nothing this pass and is back-filled once
 *     the product exists — see `ShopifyCatalogueService`).
 */

/** The three catalogue source providers (sources/providers/shopify.ts). */
export const SHOPIFY_PRODUCTS_SOURCE = 'shopify.products';
export const SHOPIFY_VARIANTS_SOURCE = 'shopify.variants';
export const SHOPIFY_COLLECTIONS_SOURCE = 'shopify.collections';

export type ShopifyCatalogueRole = 'products' | 'variants' | 'collections';

export const SHOPIFY_SOURCE_BY_ROLE: Record<ShopifyCatalogueRole, string> = {
  products: SHOPIFY_PRODUCTS_SOURCE,
  variants: SHOPIFY_VARIANTS_SOURCE,
  collections: SHOPIFY_COLLECTIONS_SOURCE,
};

export const SHOPIFY_CATALOGUE_SOURCES: readonly string[] = [
  SHOPIFY_PRODUCTS_SOURCE,
  SHOPIFY_VARIANTS_SOURCE,
  SHOPIFY_COLLECTIONS_SOURCE,
];

/** A creatable field on a catalogue database. `external_key` is the key the
 * matching `shopify.*` provider emits (sources/providers/shopify.ts's mappers);
 * `is_key` marks the row's external-key field (the immutable Shopify GID);
 * `to_name` marks the one field mapped onto the record's Name/title system
 * field (#125) so imported records are actually named. */
export interface CatalogueFieldDef {
  external_key: string;
  display_name: string;
  type: 'text' | 'number' | 'url';
  is_key?: boolean;
  to_name?: boolean;
}

export interface CatalogueDatabaseDef {
  role: ShopifyCatalogueRole;
  /** Default database name; the provision call may prefix it. */
  name: string;
  icon: string;
  fields: CatalogueFieldDef[];
}

/**
 * The three databases. Every `external_key` here is emitted by the
 * corresponding provider's mapper (shopify.ts); `title` is mapped onto the
 * record Name (`to_name`) rather than created as its own field, so a product's
 * title never appears twice.
 */
export const SHOPIFY_CATALOGUE: CatalogueDatabaseDef[] = [
  {
    role: 'products',
    name: 'Products',
    // #221: same bare-name bug as the YouTube templates — an unprefixed name is
    // not a recognised ref, so it rendered as literal clipped text.
    icon: 'set:package',
    fields: [
      { external_key: 'product_id', display_name: 'Product ID', type: 'text', is_key: true },
      { external_key: 'title', display_name: 'Name', type: 'text', to_name: true },
      { external_key: 'handle', display_name: 'Handle', type: 'text' },
      { external_key: 'status', display_name: 'Status', type: 'text' },
      { external_key: 'vendor', display_name: 'Vendor', type: 'text' },
      { external_key: 'product_type', display_name: 'Product Type', type: 'text' },
      { external_key: 'tags', display_name: 'Tags', type: 'text' },
      { external_key: 'inventory_total', display_name: 'Inventory', type: 'number' },
      { external_key: 'image_url', display_name: 'Image', type: 'url' },
      { external_key: 'image_urls', display_name: 'Image URLs', type: 'text' },
      { external_key: 'storefront_url', display_name: 'Storefront URL', type: 'url' },
      { external_key: 'admin_url', display_name: 'Admin URL', type: 'url' },
    ],
  },
  {
    role: 'variants',
    name: 'Variants',
    icon: 'set:tag',
    fields: [
      { external_key: 'variant_id', display_name: 'Variant ID', type: 'text', is_key: true },
      // The parent product's immutable GID — the foreign key the product↔variant
      // relation is materialized from.
      { external_key: 'product_id', display_name: 'Product ID', type: 'text' },
      { external_key: 'title', display_name: 'Name', type: 'text', to_name: true },
      { external_key: 'sku', display_name: 'SKU', type: 'text' },
      { external_key: 'price', display_name: 'Price', type: 'text' },
      { external_key: 'compare_at_price', display_name: 'Compare at Price', type: 'text' },
      { external_key: 'inventory_quantity', display_name: 'Inventory', type: 'number' },
      { external_key: 'admin_url', display_name: 'Admin URL', type: 'url' },
    ],
  },
  {
    role: 'collections',
    name: 'Collections',
    icon: 'set:files',
    fields: [
      { external_key: 'collection_id', display_name: 'Collection ID', type: 'text', is_key: true },
      { external_key: 'title', display_name: 'Name', type: 'text', to_name: true },
      { external_key: 'handle', display_name: 'Handle', type: 'text' },
      { external_key: 'description', display_name: 'Description', type: 'text' },
      { external_key: 'products_count', display_name: 'Products Count', type: 'number' },
      // Member products' immutable GIDs (comma-joined) — the foreign-key list
      // the product↔collection relation is materialized from.
      { external_key: 'product_ids', display_name: 'Product IDs', type: 'text' },
      { external_key: 'admin_url', display_name: 'Admin URL', type: 'url' },
    ],
  },
];

export function catalogueDef(role: ShopifyCatalogueRole): CatalogueDatabaseDef {
  const def = SHOPIFY_CATALOGUE.find((d) => d.role === role);
  if (!def) throw new Error(`No Shopify catalogue definition for role "${role}"`);
  return def;
}

/** The GID foreign-key field (its `external_key`) each non-products role carries. */
export const RELATION_KEY_FIELD: Record<'variants' | 'collections', string> = {
  variants: 'product_id',
  collections: 'product_ids',
};

/**
 * Split a stored `product_ids` value (comma-joined Shopify GIDs, per
 * mapCollection) into a de-duplicated, order-stable list of trimmed GIDs.
 * Tolerates a single GID, extra spaces, and empty entries.
 */
export function parseGidList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const gid = part.trim();
    if (gid && !seen.has(gid)) {
      seen.add(gid);
      out.push(gid);
    }
  }
  return out;
}

/** A single GID value (a variant's `product_id`), trimmed, or null when empty. */
export function parseGid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const gid = value.trim();
  return gid ? gid : null;
}

/**
 * Resolve a list of Shopify GIDs to StoryOS record ids via the products
 * lookup, dropping GIDs with no product record yet (order-independence: those
 * are back-filled once the product imports). De-duplicated, order-stable.
 */
export function resolveGids(gids: string[], productIdByGid: Map<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const gid of gids) {
    const recordId = productIdByGid.get(gid);
    if (recordId && !seen.has(recordId)) {
      seen.add(recordId);
      out.push(recordId);
    }
  }
  return out;
}

/**
 * Whether a record's current link set already equals the desired one — the
 * idempotency guard that stops a re-sync from churning identical links (and
 * their record_linked events) every cycle. Order-independent (set equality).
 */
export function linkSetEqual(current: string[], desired: string[]): boolean {
  if (current.length !== desired.length) return false;
  const c = new Set(current);
  for (const id of desired) if (!c.has(id)) return false;
  return true;
}
