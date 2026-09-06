import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { connections, records } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { WriteBackSubscriber } from '../src/sources/write-back.subscriber';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { RecordsService } from '../src/records/records.service';
import type { ConnectionFetcher } from '../src/connections/providers';

/**
 * #282 — write-back D: approval gate + run log for outbound writes.
 * Reuses the SAME approvals machinery MN-255 built for automation actions
 * (never a second gate) and the same Shopify-provider fixture #281's own
 * test file established, since a real write to gate is the point.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let connectionId: string;
let writeBackSubscriber: WriteBackSubscriber;
let jobs: JobRunnerService;

const { db, pool } = connectTestDb();

let graphqlCalls: Array<{ query: string; variables: unknown }> = [];
let responseQueue: Array<{ status: number; body: unknown }> = [];

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function setupProductDb() {
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Products' })).json().id as string;
  const field = async (display_name: string, type: string) => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name, type, config: {} });
    return { id: res.json().id as string, apiName: res.json().apiName as string };
  };
  const productId = await field('Product Id', 'text');
  const title = await field('Title', 'text');
  return { dbId, productIdFieldId: productId.id, titleFieldId: title.id, titleApiName: title.apiName };
}

async function insertRecord(dbId: string, values: Record<string, unknown>, title = 'A product'): Promise<string> {
  const [row] = await db.insert(records).values({ databaseId: dbId, title, values }).returning({ id: records.id });
  return row!.id;
}

async function createSource(dbId: string, productIdFieldId: string, titleFieldId: string, config: Record<string, unknown>) {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources`, {
    name: 'Shopify products',
    connection_id: connectionId,
    provider_source: 'shopify.products',
    config,
    field_mapping: { product_id: productIdFieldId, title: { field_id: titleFieldId, direction: 'out' } },
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

async function waitForRuns(dbId: string, sourceId: string, count = 1): Promise<Array<{ status: string; error: string | null; stats: Record<string, unknown> | null }>> {
  let runs: Awaited<ReturnType<typeof runsFor>> = [];
  for (let i = 0; i < 30 && runs.length < count; i++) {
    runs = await runsFor(dbId, sourceId);
    if (runs.length < count) await new Promise((r) => setTimeout(r, 50));
  }
  return runs;
}

/** Polls — the approval is created from the same fire-and-forget domain-event
 * listener as the source_runs row (write-back.subscriber.ts's `handle()`),
 * same async-wait convention as `waitForRuns`. */
async function pendingApprovalFor(recordId: string) {
  let match: { id: string; record_id: string; preview_text: string } | undefined;
  let rows: Array<{ id: string; record_id: string; preview_text: string }> = [];
  for (let i = 0; i < 30 && !match; i++) {
    const list = await inject('GET', `/workspaces/${wsId}/approvals?status=pending`);
    rows = list.json() as Array<{ id: string; record_id: string; preview_text: string }>;
    match = rows.find((r) => r.record_id === recordId);
    if (!match) await new Promise((r) => setTimeout(r, 50));
  }
  expect(match, `no pending approval found for record ${recordId}: ${JSON.stringify(rows)}`).toBeDefined();
  return match!;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'WriteBackGateOwner');
  wsId = (await inject('POST', '/workspaces', { name: 'Write-back Gate WS' })).json().id;

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
  jobs = app.get(JobRunnerService);
  const fetcher: ConnectionFetcher = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: unknown };
    graphqlCalls.push(body);
    const next = responseQueue.shift() ?? {
      status: 200,
      body: { data: { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } } },
    };
    return { status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
  };
  writeBackSubscriber.fetcher = fetcher;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('#282 write-back approval gate', () => {
  it('AC: require_approval_for_push holds the push, no outbound call, and it appears in the Inbox with a before→after preview', async () => {
    graphqlCalls = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/900';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Held Product' });
    const sourceId = await createSource(dbId, productIdFieldId, titleFieldId, { write_back: true, require_approval_for_push: true });

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [titleApiName]: 'Held Product (v2)' },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    // No outbound call yet — held, not pushed.
    await new Promise((r) => setTimeout(r, 150));
    expect(graphqlCalls).toEqual([]);

    const approval = await pendingApprovalFor(recordId);
    expect(approval.preview_text).toContain('Title');
    expect(approval.preview_text.toLowerCase()).toContain('held product (v2)');

    // AND it's in the run log as held, per AC "every push attempt ... lands in source_runs".
    const runs = await waitForRuns(dbId, sourceId);
    expect(runs[0]).toMatchObject({ status: 'pending_approval' });
    expect(runs[0]!.stats).toMatchObject({ pushed: false, external_key: productGid });
  });

  it('AC: approving performs the write and both the job and the run log reflect success', async () => {
    graphqlCalls = [];
    responseQueue = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/901';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Approve Me' });
    const sourceId = await createSource(dbId, productIdFieldId, titleFieldId, { write_back: true, require_approval_for_push: true });

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, { values: { [titleApiName]: 'Approve Me (v2)' } });
    const approval = await pendingApprovalFor(recordId);

    const approveRes = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`);
    expect(approveRes.statusCode, approveRes.body).toBeLessThan(300);

    // Only the approve call enqueues the job; nothing is pushed until tick().
    expect(graphqlCalls).toEqual([]);
    await jobs.tick();

    expect(graphqlCalls).toHaveLength(1);
    const variables = graphqlCalls[0]!.variables as { input: Record<string, unknown> };
    expect(variables.input).toEqual({ id: productGid, title: 'Approve Me (v2)' });

    const runs = await waitForRuns(dbId, sourceId, 2); // pending_approval, then ok
    expect(runs.some((r) => r.status === 'ok')).toBe(true);
  });

  it('AC: rejecting makes no outbound call and the rejection is recorded in the run log', async () => {
    graphqlCalls = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/902';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Reject Me' });
    const sourceId = await createSource(dbId, productIdFieldId, titleFieldId, { write_back: true, require_approval_for_push: true });

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, { values: { [titleApiName]: 'Reject Me (v2)' } });
    const approval = await pendingApprovalFor(recordId);

    const rejectRes = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/reject`, { reason: 'not yet' });
    expect(rejectRes.statusCode, rejectRes.body).toBeLessThan(300);

    await jobs.tick(); // even if ticked, nothing was enqueued for a rejection
    expect(graphqlCalls).toEqual([]); // no outbound call, ever

    const runs = await waitForRuns(dbId, sourceId, 2); // pending_approval, then rejected
    expect(runs.some((r) => r.status === 'rejected')).toBe(true);
  });

  it('MUST KEEP WORKING: require_approval_for_push OFF (default) still pushes immediately, unheld', async () => {
    graphqlCalls = [];
    responseQueue = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/903';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Not Gated' });
    const sourceId = await createSource(dbId, productIdFieldId, titleFieldId, { write_back: true }); // no require_approval_for_push

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, { values: { [titleApiName]: 'Not Gated (v2)' } });

    const runs = await waitForRuns(dbId, sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('ok');
    expect(graphqlCalls).toHaveLength(1);

    // And no approval was ever created for it.
    const list = await inject('GET', `/workspaces/${wsId}/approvals?status=pending`);
    const rows = list.json() as Array<{ record_id: string }>;
    expect(rows.some((r) => r.record_id === recordId)).toBe(false);
  });

  // MUST KEEP WORKING: a normal automation approval is unaffected by any of
  // the above — resolve()'s edit for #282 is purely an ADDITIONAL `else if`
  // branch keyed on `snapshot.action.type === 'write_back_push'`; every
  // other action type's approve/reject path is untouched. Proven by
  // approvals.test.ts, which this PR does not modify and which still passes
  // in full (see the PR's test-plan run) — not duplicated here.

  it('AC: the ping-pong cap stops a pull-triggered push from re-pushing indefinitely, and names the cap in the run log', async () => {
    graphqlCalls = [];
    responseQueue = [];
    const { dbId, productIdFieldId, titleFieldId, titleApiName } = await setupProductDb();
    const productGid = 'gid://shopify/Product/904';
    const recordId = await insertRecord(dbId, { [productIdFieldId]: productGid, [titleFieldId]: 'Depth Zero' });
    const sourceId = await createSource(dbId, productIdFieldId, titleFieldId, { write_back: true }); // ungated, so pushes fire synchronously
    const recordsService = app.get(RecordsService);

    // depth 0 — a genuine edit: pushes normally (baseline, matches the
    // "MUST KEEP WORKING" test above but re-asserted here for the sequence).
    await recordsService.update(wsId, dbId, recordId, { [titleApiName]: 'Depth Zero (edit 1)' }, admin.email, 0, 'human');
    let runs = await waitForRuns(dbId, sourceId, 1);
    expect(runs[0]!.status).toBe('ok');

    // depth 1 — the shape sources.service.ts's own pull/upsert path uses
    // (update(..., 1, 'automation')): a push-triggered-by-a-pull round trip.
    // Still under the cap (WRITE_BACK_MAX_DEPTH=2), still pushes.
    // (runs are returned NEWEST FIRST — sources.service.ts's list() orders by
    // desc(startedAt) — so the row for THIS call is always runs[0].)
    await recordsService.update(wsId, dbId, recordId, { [titleApiName]: 'Depth One (edit 2)' }, admin.email, 1, 'automation');
    runs = await waitForRuns(dbId, sourceId, 2);
    expect(runs[0]!.status).toBe('ok');

    // depth 2 — a pull that was itself triggered by a push that was itself
    // triggered by a pull: AT the cap. Refused, not pushed, and the run log
    // names the cap rather than staying silent.
    await recordsService.update(wsId, dbId, recordId, { [titleApiName]: 'Depth Two (edit 3)' }, admin.email, 2, 'automation');
    runs = await waitForRuns(dbId, sourceId, 3);
    expect(runs[0]).toMatchObject({ status: 'skipped_depth' });
    expect(runs[0]!.error).toContain('depth cap (2)');
    expect(runs[0]!.stats).toMatchObject({ pushed: false, depth: 2, max_depth: 2 });

    // Exactly 2 real GraphQL calls were made — the third was genuinely
    // refused, not merely unobserved.
    expect(graphqlCalls).toHaveLength(2);
  });
});
