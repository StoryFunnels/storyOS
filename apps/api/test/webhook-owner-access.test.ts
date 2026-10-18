import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { activityEvents, webhookDeliveries, webhookSubscriptions } from '../src/db/schema';
import { WebhooksService } from '../src/webhooks/webhooks.service';

/**
 * #920 — a webhook is a standing read into an outside system, made on someone's behalf: it may never read more than that person
 * can (Otto's decision). Webhooks are admin-only to create, so the owner reads everything while they ARE an admin; the rule bites at
 * the edges — the owner is demoted, removed, or never recorded. Then deliveries PAUSE, the webhook says why, and an admin re-owns
 * it to resume. (Records cannot live in a personal space in v1 — documents and views only — so "an event for a record the owner
 * cannot read" has no case yet; #296 inherits that obligation if it ever allows private databases.)
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string, tasks: string;
let webhooks: WebhooksService;
let sent: Array<{ url: string; body: string }> = [];
// unique per run: the dispatcher scans EVERY subscription in the database, so a reused test database must not share URLs
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const u = (name: string) => `https://example.com/${name}-${RUN}`;

const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const own = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
/** Creates a record and waits until its activity event is VISIBLE: the outbox row lands asynchronously, and a scan that runs first would simply not see it. */
const mkRecord = async (name: string) => {
  const id = (await own('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name } })).json().id as string;
  for (let i = 0; i < 100; i++) {
    if (await rawDb.query.activityEvents.findFirst({ where: eq(activityEvents.recordId, id) })) return id;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('activity event never appeared');
};
const hook = async (token: string, url: string) => {
  const res = await as(token, 'POST', `/workspaces/${ws}/webhooks`, { url, events: ['record.created'] });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const hookRow = async (id: string) => ((await own('GET', `/workspaces/${ws}/webhooks`)).json().data as Array<Record<string, unknown>>).find((h) => h.id === id)!;
const sentTo = (url: string) => sent.filter((s) => s.url === url);
const sentWith = (url: string, text: string) => sentTo(url).filter((s) => s.body.includes(text));
const membershipId = async (userId: string) => ((await own('GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id?: string; userId?: string }>).find((m) => (m.user_id ?? m.userId) === userId)!.id;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'WH Owner');
  ws = (await own('POST', '/workspaces', { name: 'Webhook Owner WS' })).json().id;
  const space = (await own('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await own('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  webhooks = app.get(WebhooksService);
  webhooks.fetcher = async (url, init) => { sent.push({ url, body: init.body }); return { status: 200 }; };
}, 240_000);
afterAll(async () => {
  // The dispatcher scans EVERY subscription in the (shared) database. Leaving these enabled would let a later test file's tick() deliver
  // our webhooks through ITS fetcher and break its counts, so remove them (and their queued deliveries, which cascade).
  await rawDb.delete(webhookSubscriptions).where(eq(webhookSubscriptions.workspaceId, ws));
  await app.close();
});

/** A second admin: invite as member then promote (joinAs only makes members/guests). */
async function newAdmin(name: string) {
  const p = await joinAs(app, owner.token, ws, name, 'member');
  const mid = await membershipId(p.id);
  expect((await own('PATCH', `/workspaces/${ws}/members/${mid}`, { role: 'admin' })).statusCode).toBe(200);
  return { ...p, mid };
}

describe('#920 deliveries pause when the owner is no longer an admin', () => {
  it('MUST KEEP WORKING: an admin-owned webhook delivers, with the full payload', async () => {
    const bea = await newAdmin('WH Bea');
    const url = u('keep');
    await hook(bea.token, url);
    await mkRecord('Delivered while owned');
    await webhooks.tick();
    expect(sentWith(url, 'Delivered while owned'), 'delivered once, full payload').toHaveLength(1);
  });

  it('a DEMOTED owner: nothing new is queued, an already-queued delivery is not sent, the webhook says why — and an admin re-owning it resumes both', async () => {
    const cy = await newAdmin('WH Cy');
    const url = u('demoted');
    const id = await hook(cy.token, url);
    await mkRecord('Queued before the demotion');
    await webhooks.scan(); // queued, not yet sent
    expect((await as(cy.token, 'GET', `/workspaces/${ws}/webhooks`)).statusCode).toBe(200);
    expect((await own('PATCH', `/workspaces/${ws}/members/${cy.mid}`, { role: 'member' })).statusCode).toBe(200);
    await mkRecord('Created after the demotion');
    await webhooks.tick();
    expect(sentTo(url), 'nothing is sent on behalf of someone who is no longer an admin').toHaveLength(0);
    const queued = await rawDb.query.webhookDeliveries.findMany({ where: eq(webhookDeliveries.subscriptionId, id) });
    expect(queued.filter((d) => JSON.stringify(d.payload).includes('Created after the demotion')), 'a paused webhook queues nothing new').toHaveLength(0);
    const paused = await hookRow(id);
    expect(String(paused.paused_reason)).toMatch(/no longer an admin/i);
    expect(paused.owner_id).toBe(cy.id);

    const taken = await own('PATCH', `/workspaces/${ws}/webhooks/${id}`, { take_ownership: true });
    expect(taken.statusCode, taken.body).toBe(200);
    expect((await hookRow(id)).paused_reason).toBeNull();
    await webhooks.tick();
    const bodies = sentTo(url).map((s) => s.body).join('\n');
    expect(bodies, 'the queued delivery goes out under the new owner').toContain('Queued before the demotion');
    expect(bodies, 'and so does what happened while paused').toContain('Created after the demotion');
  });

  it('a REMOVED owner pauses it the same way, with a different reason', async () => {
    const dee = await newAdmin('WH Dee');
    const url = u('removed');
    const id = await hook(dee.token, url);
    expect((await own('DELETE', `/workspaces/${ws}/members/${dee.mid}`)).statusCode).toBe(200);
    await mkRecord('After the owner left');
    await webhooks.tick();
    expect(sentTo(url)).toHaveLength(0);
    expect(String((await hookRow(id)).paused_reason)).toMatch(/left the workspace/i);
  });

  it('a webhook with NO recorded owner is paused until an admin takes it', async () => {
    const url = u('orphan');
    const id = await hook(owner.token, url);
    await rawDb.update(webhookSubscriptions).set({ createdBy: null }).where(eq(webhookSubscriptions.id, id));
    await mkRecord('Orphan event');
    await webhooks.tick();
    expect(sentTo(url)).toHaveLength(0);
    expect(String((await hookRow(id)).paused_reason)).toMatch(/no owner/i);
    expect((await own('PATCH', `/workspaces/${ws}/webhooks/${id}`, { take_ownership: true })).statusCode).toBe(200);
    await webhooks.tick();
    expect(sentTo(url).map((s) => s.body).join('')).toContain('Orphan event');
  });

  it('only an admin can take ownership: a member is refused and nothing changes', async () => {
    const m = await joinAs(app, owner.token, ws, 'WH Member', 'member');
    const id = await hook(owner.token, u('owned'));
    const res = await as(m.token, 'PATCH', `/workspaces/${ws}/webhooks/${id}`, { take_ownership: true });
    expect(res.statusCode).toBe(403);
    expect((await hookRow(id)).owner_id).not.toBe(m.id);
  });
});

describe('#920 the backfill: a webhook with no recorded creator goes to the workspace admin who has been there longest', () => {
  it('the migration statement assigns created_by from the earliest active admin, and leaves recorded owners alone', async () => {
    const sql = readFileSync(join(import.meta.dirname, '..', 'drizzle', '0111_webhook_owner_backfill.sql'), 'utf8');
    const id = await hook(owner.token, u('backfill'));
    const keep = await hook(owner.token, u('backfill-keep'));
    await rawDb.update(webhookSubscriptions).set({ createdBy: null }).where(eq(webhookSubscriptions.id, id));
    const ownerId = (await as(owner.token, 'GET', '/me')).json().id as string;
    for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await rawDb.execute(stmt as never);
    const row = await rawDb.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.id, id) });
    expect(row!.createdBy).toBe(ownerId);
    expect((await rawDb.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.id, keep) }))!.createdBy).toBe(ownerId);
  });
});
