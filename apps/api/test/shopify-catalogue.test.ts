import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { connections, records } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { ShopifyCatalogueService } from '../src/integrations/shopify-catalogue.service';

/**
 * #110 — Shopify product-catalogue guided setup + relation materialization.
 *
 * Part A: the one-click provision builds the three databases (provider `title`
 * mapped onto the record Name, #125), attaches the three sources, and defines
 * both relations. Part B (load-bearing): GID foreign keys resolve into real
 * record_links — idempotently and order-independently.
 *
 * Records are inserted directly here (keyed by field id, exactly how the source
 * upsert engine stores them) so the materializer is driven deterministically —
 * the on-write subscriber that fires the same path in production is a thin
 * mirror of the tested relations/auto-link.subscriber.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let svc: ShopifyCatalogueService;
let wsId: string;
let spaceId: string;
let connectionId: string;

let productsDb: string;
let variantsDb: string;
let collectionsDb: string;
let variantRel: { field_a_id: string; field_b_id: string };
let collectionRel: { field_a_id: string; field_b_id: string };

const { db, pool } = connectTestDb();
const H = () => authed(admin.token);

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: H(), payload: payload as never });
}

/** display name → field id map for a database, from GET database. */
async function fieldIds(databaseId: string): Promise<Map<string, string>> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}`);
  const fields = res.json().fields as Array<{ id: string; displayName: string }>;
  return new Map(fields.map((f) => [f.displayName, f.id]));
}

/** Insert a record directly (values keyed by field id — how the sync stores them). */
async function insertRecord(databaseId: string, title: string, values: Record<string, unknown>): Promise<string> {
  const [row] = await db.insert(records).values({ databaseId, title, values }).returning({ id: records.id });
  return row!.id;
}

async function linkedIds(databaseId: string, recordId: string, fieldId: string): Promise<string[]> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}/records/${recordId}/links/${fieldId}`);
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (res.json().data as Array<{ id: string }>).map((r) => r.id);
}

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(ShopifyCatalogueService, { strict: false });
  admin = await signUpUser(app, 'Shopkeeper');
  wsId = (await inject('POST', '/workspaces', { name: 'Shop WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  // A directly-sealed Shopify connection — decryptable so source-attach succeeds,
  // without a network healthCheck (that only runs at sync time).
  const [conn] = await db
    .insert(connections)
    .values({
      workspaceId: wsId,
      provider: 'shopify',
      name: 'Shopify',
      authSealed: seal(JSON.stringify({ shop_domain: 'acme.myshopify.com', access_token: 'shpat_x' })),
      createdBy: admin.email,
      status: 'active',
    })
    .returning();
  connectionId = conn!.id;

  const res = await inject('POST', `/workspaces/${wsId}/integrations/shopify/catalogue`, {
    space_id: spaceId,
    connection_id: connectionId,
  });
  if (res.statusCode !== 201) throw new Error(`provision failed: ${res.body}`);
  const body = res.json() as {
    databases: { products: string; variants: string; collections: string };
    relations: Array<{ key: string; field_a_id: string; field_b_id: string }>;
  };
  productsDb = body.databases.products;
  variantsDb = body.databases.variants;
  collectionsDb = body.databases.collections;
  variantRel = body.relations.find((r) => r.key === 'variants')!;
  collectionRel = body.relations.find((r) => r.key === 'collections')!;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('Shopify catalogue provisioning (#110 Part A)', () => {
  it('creates all three databases and both relations', () => {
    expect(productsDb && variantsDb && collectionsDb).toBeTruthy();
    expect(variantRel.field_a_id && variantRel.field_b_id).toBeTruthy();
    expect(collectionRel.field_a_id && collectionRel.field_b_id).toBeTruthy();
  });

  it('attaches all three sources', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/databases/${productsDb}/sources`);
    expect(res.statusCode).toBeLessThan(300);
    // Every catalogue database has exactly its own source attached.
    for (const dbId of [productsDb, variantsDb, collectionsDb]) {
      const r = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/sources`);
      expect((r.json().data as unknown[]).length, `source on ${dbId}`).toBe(1);
    }
  });

  it("maps the provider title onto the Name field (one title field, no duplicate)", async () => {
    const res = await inject('GET', `/workspaces/${wsId}/databases/${productsDb}`);
    const fields = res.json().fields as Array<{ displayName: string; type: string }>;
    expect(fields.filter((f) => f.type === 'title')).toHaveLength(1);
    expect(fields.some((f) => f.displayName === 'Product ID')).toBe(true);
  });
});

describe('product↔variant materialization (#110 Part B)', () => {
  it('links a variant to its product, back-filling when the variant imported first', async () => {
    const vFields = await fieldIds(variantsDb);
    const pFields = await fieldIds(productsDb);

    // Variant imports BEFORE its product (order-independence).
    const variantRec = await insertRecord(variantsDb, 'Small', {
      [vFields.get('Variant ID')!]: 'gid://shopify/ProductVariant/900',
      [vFields.get('Product ID')!]: 'gid://shopify/Product/111',
    });
    await svc.materializeForRecord(wsId, variantsDb, variantRec, admin.email);
    expect(await linkedIds(variantsDb, variantRec, variantRel.field_a_id)).toEqual([]);

    // Product arrives → its write back-fills the waiting variant.
    const productRec = await insertRecord(productsDb, 'Wool Hat', {
      [pFields.get('Product ID')!]: 'gid://shopify/Product/111',
    });
    await svc.materializeForRecord(wsId, productsDb, productRec, admin.email);

    expect(await linkedIds(variantsDb, variantRec, variantRel.field_a_id)).toEqual([productRec]);
    // Reverse side (Variants on the product) is navigable too.
    expect(await linkedIds(productsDb, productRec, variantRel.field_b_id)).toEqual([variantRec]);

    // Idempotent: re-materializing the variant neither duplicates nor drops the link.
    await svc.materializeForRecord(wsId, variantsDb, variantRec, admin.email);
    expect(await linkedIds(variantsDb, variantRec, variantRel.field_a_id)).toEqual([productRec]);
  });
});

describe('product↔collection materialization (#110 Part B)', () => {
  it('links a collection to every member product (many-to-many), idempotently', async () => {
    const pFields = await fieldIds(productsDb);
    const cFields = await fieldIds(collectionsDb);

    const p111 = await insertRecord(productsDb, 'Hat', {
      [pFields.get('Product ID')!]: 'gid://shopify/Product/1111',
    });
    const p222 = await insertRecord(productsDb, 'Scarf', {
      [pFields.get('Product ID')!]: 'gid://shopify/Product/2222',
    });
    const collectionRec = await insertRecord(collectionsDb, 'Winter', {
      [cFields.get('Collection ID')!]: 'gid://shopify/Collection/5',
      [cFields.get('Product IDs')!]: 'gid://shopify/Product/1111, gid://shopify/Product/2222',
    });

    await svc.materializeForRecord(wsId, collectionsDb, collectionRec, admin.email);
    expect((await linkedIds(collectionsDb, collectionRec, collectionRel.field_a_id)).sort()).toEqual(
      [p111, p222].sort(),
    );

    // Idempotent re-run.
    await svc.materializeForRecord(wsId, collectionsDb, collectionRec, admin.email);
    expect(await linkedIds(collectionsDb, collectionRec, collectionRel.field_a_id)).toHaveLength(2);
  });

  it('back-fills a collection when a member product imports later', async () => {
    const pFields = await fieldIds(productsDb);
    const cFields = await fieldIds(collectionsDb);

    // Collection references product 3333, which does not exist yet.
    const collectionRec = await insertRecord(collectionsDb, 'Summer', {
      [cFields.get('Collection ID')!]: 'gid://shopify/Collection/6',
      [cFields.get('Product IDs')!]: 'gid://shopify/Product/3333',
    });
    await svc.materializeForRecord(wsId, collectionsDb, collectionRec, admin.email);
    expect(await linkedIds(collectionsDb, collectionRec, collectionRel.field_a_id)).toEqual([]);

    // Product 3333 arrives → its write back-fills the collection.
    const p333 = await insertRecord(productsDb, 'Sun Hat', {
      [pFields.get('Product ID')!]: 'gid://shopify/Product/3333',
    });
    await svc.materializeForRecord(wsId, productsDb, p333, admin.email);
    expect(await linkedIds(collectionsDb, collectionRec, collectionRel.field_a_id)).toEqual([p333]);
  });
});
