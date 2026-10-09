import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { activityEvents, webhookDeliveries, webhookSubscriptions } from '../src/db/schema';
import { WebhooksService } from '../src/webhooks/webhooks.service';

/**
 * #853 — the lookback is a BOUND, not a proof: a transaction held open longer than
 * WEBHOOK_SCAN_LOOKBACK_SECONDS still writes events the scan never queues (PR #996, ADR-0008).
 * AC1 measured that nothing in the application holds a transaction anywhere near that long, so
 * what ships is a DETECTOR: the loss is still possible, and it is now loud instead of silent.
 *
 * These tests use a REAL held-open transaction on a real connection (not a mocked clock), with
 * the window shrunk to one second so the test does not wait five minutes. The first one asserts
 * the bound itself, so nobody reads the detector as a fix.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let db: Db;
let svc: WebhooksService;
const created: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

type Probe = { error: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn> };
let probe: Probe;
let lookback = vi.spyOn(WebhooksService.prototype as unknown as { lookbackSeconds: () => number }, 'lookbackSeconds');

async function newSub(types: string[] = ['record.created']) {
  // scan() and the audit are GLOBAL across the shared test database: retire every earlier
  // scenario's subscription so its (deliberately lost) event cannot be reported again here.
  for (const id of created) await db.update(webhookSubscriptions).set({ enabled: false }).where(eq(webhookSubscriptions.id, id));
  const wsId = (await inject('POST', '/workspaces', { name: `853 ${Math.random().toString(36).slice(2)}` })).json().id as string;
  // A new workspace seeds its founding member's row asynchronously, writing a record.created event.
  // With the window shrunk to a second that projection would itself look like a late committer, so
  // let it settle BEFORE subscribing: the floor is the subscription's creation, and everything
  // before it is correctly out of scope.
  await sleep(600);
  const res = await inject('POST', `/workspaces/${wsId}/webhooks`, { url: 'https://example.com/hook', events: types });
  expect(res.statusCode, res.body).toBe(201);
  created.push(res.json().id);
  return { wsId, subId: res.json().id as string };
}
const marker = (r: { payload: unknown }) => (r.payload as { changes?: { marker?: string } }).changes?.marker;
async function queuedMarkers(subId: string) {
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId));
  return rows.map(marker).filter((m): m is string => typeof m === 'string').sort();
}
const ev = (wsId: string, m: string, type = 'record.created') => ({ workspaceId: wsId, type, payload: { marker: m } });
const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0]));

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Detector');
  db = app.get<Db>(DB);
  svc = app.get(WebhooksService);
}, 120_000);

afterEach(() => {
  lookback.mockReset();
});

afterAll(async () => {
  for (const id of created) await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  await app.close();
});

function arm(seconds: number): Probe {
  lookback.mockReturnValue(seconds);
  // Fresh dedupe state per scenario: this service instance is shared by the whole file.
  (svc as unknown as { reportedLost: Set<string> }).reportedLost.clear();
  (svc as unknown as { warnedLongTx: Set<string> }).warnedLongTx.clear();
  const logger = (svc as unknown as { logger: { error: () => void; warn: () => void } }).logger;
  probe = { error: vi.spyOn(logger, 'error').mockImplementation(() => undefined), warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined) };
  // spyOn on an already-spied method returns the SAME spy, calls and all: start each scenario clean.
  probe.error.mockClear();
  probe.warn.mockClear();
  return probe;
}

describe('#853 — a transaction held open LONGER than the lookback', () => {
  it('THE BOUND IS REAL: its event is never queued. The detector does not change that, it makes it loud', async () => {
    const { warn, error } = arm(1);
    const { wsId, subId } = await newSub();

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const slow = db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(ev(wsId, 'A-slow'));
      started();
      await gate; // held open on a real connection
    });
    await hasStarted;

    await sleep(1300); // longer than the whole 1s window, and past half of it
    // LEADING indicator: it warns WHILE the transaction is open, before anything is lost.
    await svc.watchLongTransactions();
    expect(logged(warn).some((m) => m.includes('webhook.long_transaction') && m.includes('WEBHOOK_SCAN_LOOKBACK_SECONDS'))).toBe(true);

    // B starts later and commits at once; the scan passes A's start time by more than the window.
    await db.insert(activityEvents).values(ev(wsId, 'B-fast'));
    await svc.scan();

    release();
    await slow; // A commits: its event is stamped behind the floor
    await svc.scan();
    await svc.scan();
    expect(await queuedMarkers(subId), 'A-slow is NOT delivered: this is the residual, not a fix').toEqual(['B-fast']);

    // AUTHORITATIVE detector: the loss is reported, once, naming the event.
    expect(await svc.auditBehindFloor(subId)).toBeGreaterThanOrEqual(1);
    const lost = logged(error).filter((m) => m.includes('webhook.lost_events'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain(subId);
    expect(lost[0]).toContain('will NOT be delivered');
    expect(lost[0]).toMatch(/reported, not redelivered/);
    // ...and only once per event: the next audit stays quiet.
    expect(await svc.auditBehindFloor(subId)).toBe(0);
  });

  it('CONTROL: a transaction slower than a scan but WITHIN the window is delivered and never alarmed', async () => {
    const { warn, error } = arm(5);
    const { wsId, subId } = await newSub();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const slow = db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(ev(wsId, 'A-within'));
      started();
      await gate;
    });
    await hasStarted;
    await sleep(100);
    await db.insert(activityEvents).values(ev(wsId, 'B-fast'));
    await svc.scan();
    release();
    await slow;
    await svc.scan();
    expect(await queuedMarkers(subId)).toEqual(['A-within', 'B-fast']);
    await svc.watchLongTransactions();
    expect(await svc.auditBehindFloor(subId)).toBe(0);
    expect(logged(error).filter((m) => m.includes('webhook.lost_events'))).toEqual([]);
    expect(logged(warn).filter((m) => m.includes('webhook.long_transaction'))).toEqual([]);
  });

  it('CONTROL: an event written but not yet scanned is PENDING, not lost', async () => {
    const { error } = arm(1);
    const { wsId, subId } = await newSub();
    await db.insert(activityEvents).values(ev(wsId, 'pending-1'));
    await db.insert(activityEvents).values(ev(wsId, 'pending-2'));
    expect(await svc.auditBehindFloor(subId), 'nothing has been scanned yet: nothing can have been lost').toBe(0);
    expect(logged(error).filter((m) => m.includes('webhook.lost_events'))).toEqual([]);
    await svc.scan();
    expect(await queuedMarkers(subId)).toEqual(['pending-1', 'pending-2']);
  });

  it('CONTROL: events that were all delivered (a 300-event tie) are never reported as lost', async () => {
    const { error } = arm(1);
    const { wsId, subId } = await newSub();
    await db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(Array.from({ length: 300 }, (_, i) => ev(wsId, `t${i}`)));
    });
    for (let i = 0; i < 6; i += 1) await svc.scan();
    expect((await queuedMarkers(subId)).length).toBe(300);
    await sleep(1200); // push the tie behind the floor...
    await db.insert(activityEvents).values(ev(wsId, 'later')); // ...and move the cursor past it
    for (let i = 0; i < 3; i += 1) await svc.scan();
    expect(await svc.auditBehindFloor(subId)).toBe(0);
    expect(logged(error).filter((m) => m.includes('webhook.lost_events'))).toEqual([]);
  });

  it('KNOWN LIMIT, pinned so nobody is surprised: editing a subscription to add an event type makes old history of that type look lost, and the message says so', async () => {
    const { error } = arm(1);
    const { wsId, subId } = await newSub(['record.created']);
    await db.insert(activityEvents).values(ev(wsId, 'old-update', 'record.updated')); // never subscribed to
    await sleep(1200);
    await db.insert(activityEvents).values(ev(wsId, 'newer', 'record.created'));
    await svc.scan();
    const edit = await inject('PATCH', `/workspaces/${wsId}/webhooks/${subId}`, { events: ['record.created', 'record.updated'] });
    expect(edit.statusCode, edit.body).toBeLessThan(300);
    expect(await svc.auditBehindFloor(subId)).toBeGreaterThanOrEqual(1);
    const msg = logged(error).find((m) => m.includes('webhook.lost_events'))!;
    expect(msg).toMatch(/EDITED recently/);
  });
});
