import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { activityEvents, webhookDeliveries, webhookSubscriptions } from '../src/db/schema';
import { WebhooksService } from '../src/webhooks/webhooks.service';

/**
 * #850 — the webhook scan silently dropped events, to someone else's system, with no error.
 *
 * MECHANISM ONE (a tie): the scan was `created_at > cursor_at ORDER BY created_at LIMIT 200`
 * and advanced cursor_at to the last row's timestamp. Every event of one transaction shares a
 * created_at, so a tie spanning the 200-row boundary lost its remainder for good: 300 events in
 * one transaction, five scans, 200 delivered, 100 gone. (Probed on main, then pinned here.)
 *
 * MECHANISM TWO (a slow transaction): created_at is the transaction START time, not the commit
 * time. A transaction that begins before a scan and commits after it writes rows stamped BEHIND
 * the cursor the scan just advanced, and they were never delivered. No tie, no bulk run — one
 * slow transaction overlapping one scan. (Probed below.)
 *
 * Every assertion is about what was actually QUEUED, and checks both directions: nothing
 * missing AND nothing delivered twice (widening to `>=` alone would trade loss for duplicates).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string; // the workspace the CURRENT test writes to
let db: Db;
let svc: WebhooksService;
/** Every subscription this file creates. scan() and flush() are GLOBAL across the shared test
 *  database, so they are deleted afterwards (deliveries cascade) or a pending delivery of ours
 *  would be sent by another file's tick(). */
const created: string[] = [];

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

/** A fresh workspace per test: the scan is per-workspace, so events never bleed between tests. */
async function freshWorkspace() {
  wsId = (await inject('POST', '/workspaces', { name: `850 ${Math.random().toString(36).slice(2)}` })).json().id;
  return wsId;
}
const TYPE = 'record.created'; // a real, subscribable event type
async function newSubscription(types: string[] = [TYPE]) {
  await freshWorkspace();
  const res = await inject('POST', `/workspaces/${wsId}/webhooks`, { url: 'https://example.com/hook', events: types });
  expect(res.statusCode, res.body).toBe(201);
  created.push(res.json().id as string);
  return res.json().id as string;
}
const insertEvents = (rows: Array<{ type: string; marker: string }>) =>
  rows.map((r) => ({ workspaceId: wsId, type: r.type, payload: { marker: r.marker } }));

/** Scan until THIS subscription's queue stops growing for two scans in a row, with a hard cap so
 *  a stuck scan fails loudly. (scan()'s return value is global across the shared test database,
 *  so it cannot be used to tell when this subscription is done.) */
async function drain(subId: string): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 30; i += 1) {
    await svc.scan();
    const now = (await delivered(subId)).length;
    stable = now === last ? stable + 1 : 0;
    if (stable >= 2) return;
    last = now;
  }
  throw new Error('scan never settled: it is stuck re-reading the same rows');
}

/** Deliveries for the events THIS test wrote (a fresh workspace also seeds its own record.created
 *  events, e.g. the founding member's row, which are not what these tests are about). */
async function delivered(subId: string) {
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId));
  return rows.filter((r) => typeof (r.payload as { changes?: { marker?: unknown } }).changes?.marker === 'string');
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ScanOwner');
  db = app.get<Db>(DB);
  svc = app.get(WebhooksService);
}, 120_000);

afterAll(async () => {
  for (const id of created) await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  await app.close();
});

describe('#850 mechanism one — a tie spanning the batch boundary', () => {
  it('300 events written in ONE transaction: all 300 are queued, once each, by repeated scans', async () => {
    const subId = await newSubscription();
    await db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(insertEvents(Array.from({ length: 300 }, (_, i) => ({ type: TYPE, marker: `e${i}` }))));
    });
    // The premise: they really do share one created_at (otherwise this proves nothing).
    const distinctTs = await db.execute(sql`SELECT count(DISTINCT created_at)::int AS n FROM activity_events WHERE workspace_id = ${wsId}`);
    expect((distinctTs.rows[0] as { n: number }).n).toBe(1);

    await drain(subId);
    const rows = await delivered(subId);
    expect(rows.length, 'every event queued').toBe(300);
    expect(new Set(rows.map((r) => r.eventId)).size, 'none queued twice').toBe(300);
    await svc.scan();
    expect((await delivered(subId)).length, 'and a further scan adds nothing').toBe(300);
  });

  it('exactly-once across the boundary: a second batch of ties after the first is drained is also whole, with no overlap', async () => {
    const subId = await newSubscription();
    for (const batch of [250, 250]) {
      await db.transaction(async (tx) => {
        await tx.insert(activityEvents).values(insertEvents(Array.from({ length: batch }, (_, i) => ({ type: TYPE, marker: `b${batch}-${i}` }))));
      });
      await drain(subId);
    }
    const rows = await delivered(subId);
    expect(rows).toHaveLength(500);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(500);
  });

  it('ordinary delivery is unchanged: events come out oldest first, and a quiet scan queues nothing', async () => {
    const subId = await newSubscription();
    for (let i = 0; i < 5; i += 1) {
      await db.insert(activityEvents).values(insertEvents([{ type: TYPE, marker: `o${i}` }]));
      await new Promise((r) => setTimeout(r, 5)); // occurred_at is millisecond-resolution: keep them apart
    }
    await drain(subId);
    // The delivery rows of one scan are inserted together and share a created_at, so order by the
    // event's own occurred_at (each was written in its own transaction).
    const rows = (await delivered(subId)).sort((a, b) => Date.parse((a.payload as { occurred_at: string }).occurred_at) - Date.parse((b.payload as { occurred_at: string }).occurred_at));
    expect(rows).toHaveLength(5);
    const markers = rows.map((r) => ((r.payload as { changes: { marker: string } }).changes.marker));
    expect(markers).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    await svc.scan();
    expect((await delivered(subId)).length).toBe(5);
  });

  it('a NEW subscription never replays history: events written before it existed are not delivered', async () => {
    await freshWorkspace();
    await db.insert(activityEvents).values(insertEvents([{ type: TYPE, marker: 'before' }]));
    const sub = await inject('POST', `/workspaces/${wsId}/webhooks`, { url: 'https://example.com/hook', events: [TYPE] });
    const subId = sub.json().id as string;
    created.push(subId);
    await db.insert(activityEvents).values(insertEvents([{ type: TYPE, marker: 'after' }]));
    await drain(subId);
    const rows = await delivered(subId);
    expect(rows.map((r) => (r.payload as { changes: { marker: string } }).changes.marker)).toEqual(['after']);
  });
});

describe('#850 mechanism two — a transaction that starts before a scan and commits after it', () => {
  it('its events are still delivered (they carry a created_at BEHIND the cursor the scan advanced)', async () => {
    const subId = await newSubscription();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });

    // A: begins first, writes an event stamped with ITS start time, and stays open.
    const slow = db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(insertEvents([{ type: TYPE, marker: 'A-slow' }]));
      started();
      await gate;
    });
    await hasStarted;
    await new Promise((r) => setTimeout(r, 30)); // B must start strictly after A

    // B: starts later and commits at once.
    await db.insert(activityEvents).values(insertEvents([{ type: TYPE, marker: 'B-fast' }]));
    await svc.scan(); // the scan sees B only, and advances its cursor to B's time
    expect((await delivered(subId)).length, 'so far only B is visible').toBe(1);

    release();
    await slow; // A commits NOW: its row is older than the cursor
    await drain(subId);

    const markers = (await delivered(subId)).map((r) => (r.payload as { changes: { marker: string } }).changes.marker).sort();
    expect(markers, 'both delivered, once each').toEqual(['A-slow', 'B-fast']);
  });
});
