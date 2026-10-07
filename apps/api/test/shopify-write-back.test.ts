import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { connections, records } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { WriteBackSubscriber } from '../src/sources/write-back.subscriber';
import type { ConnectionFetcher } from '../src/connections/providers';

/**
 * #281 (write-back, slice C) — the first REAL provider push: Shopify products.
 * Exercises the whole round trip end to end — editing an `out`-mapped field
 * on a StoryOS record fires the domain event, WriteBackSubscriber resolves
 * it through the mapping, and the Shopify provider's push() issues the
 * productUpdate GraphQL mutation — without a real Shopify store, by
 * overriding WriteBackSubscriber's own fetcher seam (same pattern
 * SourcesService.fetcher uses for the pull side, e.g. sources.test.ts).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let connectionId: string;
let writeBackSubscriber: WriteBackSubscriber;

const { db, pool } = connectTestDb();

/** Captures every call made through WriteBackSubscriber's fetcher —
 * production sends exactly one push per relevant edit, so tests assert on
 * this list's shape rather than re-deriving Shopify's GraphQL wire format. */
let graphqlCalls: Array<{ query: string; variables: unknown }> = [];
/** Queue of canned Shopify GraphQL responses, consumed one per call — lets a
 * single test assert a rejection without a separate app/module per case. */
let responseQueue: Array<{ status: number; body: unknown }> = [];

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

/**
 * A fresh database + Product Id/Title/Vendor fields, ONE per test — sharing a
 * database (and its field ids) across tests would let an EARLIER test's
 * still-active write_back source fire a second, cross-contaminating push the
 * moment a later test edits the very same field id, stealing the other
 * test's queued mock response. Mirrors sources.test.ts's
 * setupDatabaseAndConnection, which creates a fresh database per test for
 * exactly this reason.
 */
async function setupProductDb() {
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Products' })).json()
    .id as string;
  const field = async (display_name: string, type: string) => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name, type, config: {} });
    return { id: res.json().id as string, apiName: res.json().apiName as string };
  };
  const productId = await field('Product Id', 'text');
  const title = await field('Title', 'text');
  const vendor = await field('Vendor', 'text');
  return { dbId, productIdFieldId: productId.id, titleFieldId: title.id, titleApiName: title.apiName, vendorFieldId: vendor.id, vendorApiName: vendor.apiName };
}

async function insertRecord(dbId: string, values: Record<string, unknown>, title = 'A product'): Promise<string> {
  const [row] = await db.insert(records).values({ databaseId: dbId, title, values }).returning({ id: records.id });
  return row!.id;
}

async function createSource(
  dbId: string,
  productIdFieldId: string,
  fieldMapping: Record<string, unknown>,
  writeBack: boolean,
) {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources`, {
    name: 'Shopify products',
    connection_id: connectionId,
    provider_source: 'shopify.products',
    config: { write_back: writeBack },
    field_mapping: fieldMapping,
    external_key_field_id: productIdFieldId,
    schedule: 'day',
  });
  expect(res.statusCode, `source create failed: ${res.body}`).toBe(201);
  return res.json().id as string;
}

async function runsFor(dbId: string, sourceId: string) {
  return (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/runs`)).json().data as Array<{
    status: string;
    error: string | null;
    stats: Record<string, unknown> | null;
  }>;
}

/** Polls until at least one run row exists (or the timeout elapses) — the
 * push fires from a fire-and-forget domain-event listener, same async-wait
 * convention as shopify-webhook.test.ts's relation-materialization checks. */
async function waitForRun(dbId: string, sourceId: string): Promise<Array<{ status: string; error: string | null; stats: Record<string, unknown> | null }>> {
  let runs: Awaited<ReturnType<typeof runsFor>> = [];
  for (let i = 0; i < 30 && runs.length === 0; i++) {
    runs = await runsFor(dbId, sourceId);
    if (runs.length === 0) await new Promise((r) => setTimeout(r, 50));
  }
  return runs;
}

/** No run appears within a short window — used to assert "nothing pushed". */
async function assertNoRun(dbId: string, sourceId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  expect(await runsFor(dbId, sourceId)).toEqual([]);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ShopifyWriteBack');
  wsId = (await inject('POST', '/workspaces', { name: 'Shopify Write-back WS' })).json().id;

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

  writeBackSubscriber = app.get(WriteBackSubscriber);
  const fetcher: ConnectionFetcher = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: unknown };
    graphqlCalls.push(body);
    const next = responseQueue.shift() ?? {
      status: 200,
      body: { data: { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } } },
    };
    return {
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
  writeBackSubscriber.fetcher = fetcher;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('Shopify write-back push (#281)', () => {
  it('editing an out-mapped field pushes a productUpdate mutation naming only that field, and logs an ok run', async () => {
    graphqlCalls = [];
    responseQueue = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/111';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Wool Hat' });
    const sourceId = await createSource(
      dbId,
      productIdFieldId,
      { product_id: productIdFieldId, title: { field_id: titleFieldId, direction: 'out' } },
      true,
    );

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [titleApiName]: 'Wool Hat (v2)' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const runs = await waitForRun(dbId, sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok' });
    expect(runs[0]!.stats).toMatchObject({ pushed: true, external_key: productGid, pushed_keys: ['title'] });

    expect(graphqlCalls).toHaveLength(1);
    const variables = graphqlCalls[0]!.variables as { input: Record<string, unknown> };
    expect(variables.input).toEqual({ id: productGid, title: 'Wool Hat (v2)' });
  });

  it('an in-mapped field edit pushes nothing — no GraphQL call, no run row', async () => {
    graphqlCalls = [];
    const { dbId, productIdFieldId, vendorFieldId, vendorApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/222';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [vendorFieldId]: 'Acme Co' });
    // vendor is mapped IN (bare id, the legacy/default shape) — never out/both.
    const sourceId = await createSource(dbId, productIdFieldId, { product_id: productIdFieldId, vendor: vendorFieldId }, true);

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [vendorApiName]: 'Acme Co (renamed)' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    await assertNoRun(dbId, sourceId);
    expect(graphqlCalls).toEqual([]);
  });

  it('write_back OFF (default): editing an out-mapped field still makes no outbound call at all', async () => {
    graphqlCalls = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/333';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Denim Jacket' });
    const sourceId = await createSource(
      dbId,
      productIdFieldId,
      { product_id: productIdFieldId, title: { field_id: titleFieldId, direction: 'out' } },
      false, // write_back off
    );

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [titleApiName]: 'Denim Jacket (v2)' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    await assertNoRun(dbId, sourceId);
    expect(graphqlCalls).toEqual([]); // absence of the request, not just an unread flag
  });

  it('a Shopify rejection (userErrors) surfaces as an errored run naming the provider error; the local edit survives', async () => {
    graphqlCalls = [];
    responseQueue = [
      { status: 200, body: { data: { productUpdate: { product: null, userErrors: [{ field: ['status'], message: 'Invalid status value' }] } } } },
    ];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/444';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Rejected Product' });
    const sourceId = await createSource(
      dbId,
      productIdFieldId,
      { product_id: productIdFieldId, title: { field_id: titleFieldId, direction: 'out' } },
      true,
    );

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [titleApiName]: 'Rejected Product (v2)' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const runs = await waitForRun(dbId, sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('error');
    expect(runs[0]!.error).toContain('Invalid status value');

    // The local edit is authoritative and untouched by the rejected push.
    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`);
    expect(after.json().values[titleApiName]).toBe('Rejected Product (v2)');
  });

  it('a "both"-mapped field edit pushes exactly like "out"', async () => {
    graphqlCalls = [];
    responseQueue = [];
    const { dbId, productIdFieldId, vendorFieldId, vendorApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/555';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [vendorFieldId]: 'Acme Co' });
    const sourceId = await createSource(
      dbId,
      productIdFieldId,
      { product_id: productIdFieldId, vendor: { field_id: vendorFieldId, direction: 'both' } },
      true,
    );

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [vendorApiName]: 'Acme Global' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const runs = await waitForRun(dbId, sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('ok');
    const variables = graphqlCalls[0]!.variables as { input: Record<string, unknown> };
    expect(variables.input).toEqual({ id: productGid, vendor: 'Acme Global' });
  });
});
