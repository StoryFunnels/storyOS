import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { activityEvents, webhookDeliveries, webhookSubscriptions } from '../src/db/schema';
import { WebhooksService } from '../src/webhooks/webhooks.service';

/**
 * #956 — scan() and auditBehindFloor() read `findMany({ limit: 100 })` with no ORDER BY, so the 101st enabled subscription in the
 * whole database was never scanned: its events were never queued and the loss audit never looked at it. Nothing failed, nothing
 * logged. The fillers below are admin-owned and enabled but subscribe to no events, so they cost nothing — they only occupy slots.
 */
const { db } = connectTestDb();
let app: NestFastifyApplication;
let token: string;
let ws: string, tasks: string, ownerId: string;
let webhooks: WebhooksService;
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const target = `https://example.com/paging-${RUN}`;
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Paging Owner')).token;
  ws = (await as('POST', '/workspaces', { name: 'Paging WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  webhooks = app.get(WebhooksService);
  webhooks.fetcher = async () => ({ status: 200 });
  // Learn the owner id from a real webhook, so fillers are admin-owned exactly like a real one.
  const probe = (await as('POST', `/workspaces/${ws}/webhooks`, { url: `https://example.com/probe-${RUN}`, events: ['record.created'] })).json().id as string;
  ownerId = (await db.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.id, probe) }))!.createdBy!;
  await db.insert(webhookSubscriptions).values(
    Array.from({ length: 305 }, (_, i) => ({ workspaceId: ws, url: `https://example.com/filler-${RUN}-${i}`, events: [], secret: 'x', createdBy: ownerId })),
  );
}, 240_000);
afterAll(async () => {
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.workspaceId, ws));
  await app.close();
});

describe('#956 every enabled subscription is scanned, not the first 100', () => {
  it('delivers to a subscription created AFTER more than 100 others', async () => {
    const res = await as('POST', `/workspaces/${ws}/webhooks`, { url: target, events: ['record.created'] });
    expect(res.statusCode, res.body).toBe(201);
    const subId = res.json().id as string;
    const rec = (await as('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'Past the hundredth' } })).json().id as string;
    for (let i = 0; i < 100 && !(await db.query.activityEvents.findFirst({ where: eq(activityEvents.recordId, rec) })); i++) await new Promise((r) => setTimeout(r, 30));
    await webhooks.scan();
    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId));
    expect(queued.length, 'the 106th subscription was never scanned').toBeGreaterThanOrEqual(1);
  });

  it('the loss audit visits it too', async () => {
    const spy = vi.spyOn(webhooks as unknown as { reportLost: (s: { url?: string }, t: string[]) => Promise<number> }, 'reportLost');
    const sub = (await db.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.url, target) }))!;
    await webhooks.auditBehindFloor();
    expect(spy.mock.calls.map((c) => c[0].id ?? (c[0] as { id?: string }).id)).toContain(sub.id);
    spy.mockRestore();
  });
});
