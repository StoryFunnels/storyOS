import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { connections, records } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { SourcesService } from '../src/sources/sources.service';
import { mapProduct } from '../src/sources/providers/shopify';

/**
 * #24 — Shopify real-time webhook sync.
 *
 * The receiver is HMAC-verified (valid signature accepted, tampered body
 * rejected) and upserts through the SAME idempotent, GID-keyed engine the
 * scheduled sync uses — so a push and a scheduled tick for the same object
 * converge on ONE record (no duplicates, no fighting), and the relation
 * materializer fires off the resulting record write exactly as it does for a
 * scheduled sync. This test exercises all of that against the real app + DB.
 */

const SHOP = 'acme.myshopify.com';
const WEBHOOK_SECRET = 'shpss_integration_secret';
process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;

let app: NestFastifyApplication;
let sourcesSvc: SourcesService;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let connectionId: string;
let productsDb: string;
let variantsDb: string;
let collectionsDb: string;
let variantRel: { field_a_id: string; field_b_id: string };

const { db, pool } = connectTestDb();
const H = () => authed(admin.token);

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: H(), payload: payload as never });
}

async function fieldIds(databaseId: string): Promise<Map<string, string>> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}`);
  const fields = res.json().fields as Array<{ id: string; displayName: string }>;
  return new Map(fields.map((f) => [f.displayName, f.id]));
}

/** How many live records in `databaseId` carry `value` in field `fieldId`. */
async function countByField(databaseId: string, fieldId: string, value: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(records)
    .where(
      and(
        eq(records.databaseId, databaseId),
        isNull(records.deletedAt),
        sql`(${records.values}->>${fieldId}) = ${value}`,
      ),
    );
  return row?.n ?? 0;
}

async function recordIdByField(databaseId: string, fieldId: string, value: string): Promise<string | null> {
  const [row] = await db
    .select({ id: records.id })
    .from(records)
    .where(
      and(
        eq(records.databaseId, databaseId),
        isNull(records.deletedAt),
        sql`(${records.values}->>${fieldId}) = ${value}`,
      ),
    );
  return row?.id ?? null;
}

async function linkedIds(databaseId: string, recordId: string, fieldId: string): Promise<string[]> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${databaseId}/records/${recordId}/links/${fieldId}`);
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (res.json().data as Array<{ id: string }>).map((r) => r.id);
}

/** POST a signed (or deliberately tampered) webhook, exactly as Shopify would. */
async function postWebhook(
  topic: string,
  body: unknown,
  opts: { secret?: string; shopDomain?: string; tamperBody?: string } = {},
) {
  const raw = JSON.stringify(body);
  // The signature is always computed over the legitimate `raw` body; when
  // `tamperBody` is set we send DIFFERENT bytes, so a correct receiver's HMAC
  // over the wire bytes must not match — that's the tamper case.
  const hmac = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(Buffer.from(raw, 'utf8')).digest('base64');
  return app.inject({
    method: 'POST',
    url: `/api/v1/providers/shopify/webhook/${connectionId}`,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': opts.shopDomain ?? SHOP,
      'x-shopify-hmac-sha256': hmac,
    },
    payload: opts.tamperBody ?? raw,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  sourcesSvc = app.get(SourcesService, { strict: false });
  admin = await signUpUser(app, 'Shopkeeper');
  wsId = (await inject('POST', '/workspaces', { name: 'Shop WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  const [conn] = await db
    .insert(connections)
    .values({
      workspaceId: wsId,
      provider: 'shopify',
      name: 'Shopify',
      authSealed: seal(JSON.stringify({ shop_domain: SHOP, access_token: 'shpat_x' })),
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
  const bodyJson = res.json() as {
    databases: { products: string; variants: string; collections: string };
    relations: Array<{ key: string; field_a_id: string; field_b_id: string }>;
  };
  productsDb = bodyJson.databases.products;
  variantsDb = bodyJson.databases.variants;
  collectionsDb = bodyJson.databases.collections;
  variantRel = bodyJson.relations.find((r) => r.key === 'variants')!;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HMAC verification', () => {
  it('rejects a tampered body with 401 (HMAC is over the wire bytes)', async () => {
    const res = await postWebhook(
      'products/create',
      { id: 5001, title: 'Signed' },
      { tamperBody: JSON.stringify({ id: 5001, title: 'HACKED' }) },
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await postWebhook('products/create', { id: 5002, title: 'X' }, { secret: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a shop-domain that is not this connection with 401', async () => {
    const res = await postWebhook('products/create', { id: 5003, title: 'X' }, { shopDomain: 'evil.myshopify.com' });
    expect(res.statusCode).toBe(401);
  });
});

describe('idempotent, GID-keyed upsert + convergence', () => {
  const productBody = {
    id: 111,
    title: 'Wool Hat',
    handle: 'wool-hat',
    status: 'active',
    variants: [{ id: 900, product_id: 111, title: 'Small', sku: 'WH-S', price: '19.99', inventory_quantity: 3 }],
  };
  const productGid = 'gid://shopify/Product/111';
  const variantGid = 'gid://shopify/ProductVariant/900';

  it('a valid products/create webhook upserts the product AND its nested variant, keyed by GID', async () => {
    const res = await postWebhook('products/create', productBody);
    expect(res.statusCode, res.body).toBe(200);

    const pFields = await fieldIds(productsDb);
    const vFields = await fieldIds(variantsDb);
    expect(await countByField(productsDb, pFields.get('Product ID')!, productGid)).toBe(1);
    expect(await countByField(variantsDb, vFields.get('Variant ID')!, variantGid)).toBe(1);
  });

  it('re-delivering the SAME webhook creates no duplicate (idempotent by GID)', async () => {
    await postWebhook('products/update', { ...productBody, title: 'Wool Hat (v2)' });
    const pFields = await fieldIds(productsDb);
    expect(await countByField(productsDb, pFields.get('Product ID')!, productGid)).toBe(1);
  });

  it('a scheduled-sync upsert of the SAME GID converges to one record (no second write path)', async () => {
    // Feed the shared upsert engine the GraphQL sync's own mapper output for the
    // same product GID — the exact bytes a scheduled tick would produce.
    const scheduled = mapProduct(SHOP, { id: productGid, title: 'Wool Hat', handle: 'wool-hat', status: 'active' });
    const out = await sourcesSvc.ingestExternalItems(wsId, connectionId, 'shopify.products', [scheduled]);
    expect(out.matched).toBe(true);
    const pFields = await fieldIds(productsDb);
    // Still exactly one — webhook and schedule share the GID-keyed record.
    expect(await countByField(productsDb, pFields.get('Product ID')!, productGid)).toBe(1);
  });

  it('materializes the product↔variant relation off the webhook write (async subscriber)', async () => {
    const vFields = await fieldIds(variantsDb);
    const productId = await recordIdByField(productsDb, (await fieldIds(productsDb)).get('Product ID')!, productGid);
    const variantId = await recordIdByField(variantsDb, vFields.get('Variant ID')!, variantGid);
    expect(productId && variantId).toBeTruthy();

    let linked: string[] = [];
    for (let i = 0; i < 30 && !linked.includes(productId!); i++) {
      linked = await linkedIds(variantsDb, variantId!, variantRel.field_a_id);
      if (!linked.includes(productId!)) await new Promise((r) => setTimeout(r, 50));
    }
    expect(linked).toContain(productId);
  });
});

describe('collections + non-actionable deliveries', () => {
  it('a collections/update webhook upserts the collection scalar fields, keyed by GID', async () => {
    const res = await postWebhook('collections/update', {
      id: 77,
      title: 'Winter',
      handle: 'winter',
      body_html: '<p>Cold</p>',
    });
    expect(res.statusCode).toBe(200);
    const cFields = await fieldIds(collectionsDb);
    expect(await countByField(collectionsDb, cFields.get('Collection ID')!, 'gid://shopify/Collection/77')).toBe(1);
  });

  it('a delete is acked as a no-op (converges with the sync, which never deletes)', async () => {
    const res = await postWebhook('products/delete', { id: 111 });
    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe('products/delete:noop');
    // The record is intentionally left intact.
    const pFields = await fieldIds(productsDb);
    expect(await countByField(productsDb, pFields.get('Product ID')!, 'gid://shopify/Product/111')).toBe(1);
  });

  it('an unhandled topic is acked with 200 and writes nothing', async () => {
    const res = await postWebhook('orders/create', { id: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBeUndefined();
  });
});
