import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// Before ANY import: the API reads STRIPE_SECRET_KEY once, when it boots. A test key makes StripeService enabled, which is exactly what
// "hosted" means to the retention purge (no mock of the detection: the real getter decides).
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_retention_hosted_detection';
});

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { activityEvents, billingSubscriptions } from '../src/db/schema';
import { env } from '../src/config/env';
import { recordVersions, recordFieldChanges } from '../src/db/schema';
import { ActivityRetentionService } from '../src/activity/activity-retention.service';
import { EntitlementsService } from '../src/billing/entitlements.service';

/**
 * Ticket #1024, Vera's blocker: the per-plan path was only ever tested with `perPlan: true` passed in, so making a HOSTED deployment ignore
 * the plan (read the env variable instead) passed every test. These tests boot the API with a Stripe key, call the DEFAULT `purge()` with
 * no options, and let the real detection pick the path.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let service: ActivityRetentionService;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
/** Existing tests are about WHAT the purge deletes; the not-before gate (PURGE_NOT_BEFORE, ticket #1385) has its own describe below and runs with the real default. */
const OPEN = new Date(0);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** Hosted Free caps the workspaces one person can create, so every workspace gets its own owner. */
async function newWs(plan: 'pro' | null) {
  const u = await signUpUser(app, `Hosted Owner ${Math.random().toString(36).slice(2, 8)}`);
  const as = (method: string, url: string, payload?: unknown) => call(app, u.token, method, url, payload);
  const w = (await as('POST', '/workspaces', { name: `Hosted ${plan ?? 'free'}` })).json().id as string;
  const space = (await as('GET', `/workspaces/${w}/spaces`)).json()[0].id;
  const db = (await as('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Things' })).json().id;
  const rec = (await as('POST', `/workspaces/${w}/databases/${db}/records`, { values: { name: 'r' } })).json().id as string;
  if (plan) await raw.insert(billingSubscriptions).values({ workspaceId: w, plan });
  return { ws: w, rec, ownerId: (await as('GET', '/me')).json().id as string };
}
const seed = async (ws: string, rec: string, days: number, ownerId = 'x') =>
  (await raw.insert(activityEvents).values({ workspaceId: ws, recordId: rec, actorId: ownerId, type: 'comment.created', payload: {}, createdAt: ago(days) }).returning({ id: activityEvents.id }))[0]!.id;
const present = async (ids: string[]) => new Set((await raw.select({ id: activityEvents.id }).from(activityEvents).where(inArray(activityEvents.id, ids))).map((r) => r.id));
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const e = env() as unknown as Record<string, string | undefined>;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, e[k]]));
  Object.assign(e, patch);
  try {
    return await fn();
  } finally {
    Object.assign(e, before);
  }
}

beforeAll(async () => {
  app = await createTestApp();
  service = app.get(ActivityRetentionService);
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('hosted detection is real: a Stripe key turns the plan windows on', () => {
  it('premise: this deployment really is hosted', () => {
    expect(app.get(EntitlementsService).hostedPlans).toBe(true);
  });

  it('the DEFAULT purge applies each workspace\'s plan (Free 30 days, Pro 365), and ignores ACTIVITY_EVENTS_RETENTION_DAYS entirely', async () => {
    const free = await newWs(null);
    const pro = await newWs('pro');
    const f10 = await seed(free.ws, free.rec, 40); // past 30
    const f3 = await seed(free.ws, free.rec, 10); // inside 30
    const p10 = await seed(pro.ws, pro.rec, 100); // inside 365
    const p40 = await seed(pro.ws, pro.rec, 400); // past 365
    // An operator variable that would delete nothing (1000) or everything old (1) must change nothing on a hosted deployment.
    for (const v of ['1000', '1', undefined]) {
      await withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: v }, async () => {
        const out = await service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN });
        expect(out.disabled, `env ${String(v)}: hosted is never "disabled"`).toBe(false);
      });
    }
    const left = await present([f10, f3, p10, p40]);
    expect(left.has(f10), 'Free: 40 days old is past its 30').toBe(false);
    expect(left.has(f3), 'Free: 10 days old stays').toBe(true);
    expect(left.has(p10), 'Pro: 100 days old is inside its 365').toBe(true);
    expect(left.has(p40), 'Pro: 400 days old is past its 365').toBe(false);
  });

  it('a workspace with no billing row is Free: 30 days', async () => {
    const free = await newWs(null);
    expect((await raw.select().from(billingSubscriptions).where(eq(billingSubscriptions.workspaceId, free.ws))).length, 'premise: no billing row').toBe(0);
    const e = await seed(free.ws, free.rec, 31);
    const inside = await seed(free.ws, free.rec, 29);
    await service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN });
    expect((await present([e])).size).toBe(0);
    expect((await present([inside])).size, '29 days is inside the 30').toBe(1);
  });

  it('onModuleInit schedules the purge on a hosted deployment even with the variable unset (a self-host-only gate would never run it)', async () => {
    const e = env() as unknown as Record<string, string | undefined>;
    vi.useFakeTimers();
    const purge = vi.spyOn(service, 'purge').mockResolvedValue({ deleted: 0, batches: 0, capped: false, disabled: false, held: false });
    const before = e.NODE_ENV;
    e.NODE_ENV = 'production';
    try {
      await withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: undefined }, async () => {
        service.onModuleInit();
        vi.advanceTimersByTime(61_000);
      });
      expect(purge, 'ran after the first-run delay').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purge, 'NOT again an hour later: the tick is daily, not hourly').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      expect(purge.mock.calls.length, 'and again once a day has passed').toBe(2);
    } finally {
      service.onModuleDestroy();
      e.NODE_ENV = before;
      purge.mockRestore();
      vi.useRealTimers();
    }
  });

  it('the SCHEDULER passes through the not-before gate: a tick on a clock before 2026-12-27 deletes nothing, one after it deletes per plan (ticket #1385)', async () => {
    const e = env() as unknown as Record<string, string | undefined>;
    const free = await newWs(null);
    const purge = vi.spyOn(service, 'purge');
    const before = e.NODE_ENV;
    e.NODE_ENV = 'production';
    try {
      for (const [clock, expectGone] of [[new Date('2026-12-26T12:00:00Z'), false], [new Date('2026-12-28T12:00:00Z'), true]] as const) {
        // Seeded 40 days before the fake clock, so Free's 30 days has passed in both runs. `seed` counts back from the real clock.
        const row = await seed(free.ws, free.rec, (Date.now() - clock.getTime()) / DAY + 40);
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
        vi.setSystemTime(clock);
        purge.mockClear();
        await withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: undefined }, async () => {
          service.onModuleInit();
          await vi.advanceTimersByTimeAsync(61_000);
        });
        service.onModuleDestroy();
        const result = await purge.mock.results[0]!.value;
        vi.useRealTimers();
        expect(result.held, `${clock.toISOString()}: held`).toBe(!expectGone);
        expect((await present([row])).size === 0, `${clock.toISOString()}: the Free row is ${expectGone ? 'deleted' : 'kept'}`).toBe(expectGone);
      }
    } finally {
      service.onModuleDestroy();
      e.NODE_ENV = before;
      purge.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('record version history on a hosted FREE workspace (ticket #1385: Free is 14 days, was 0 = capture off)', () => {
  it('an edit on a Free workspace now captures a whole-record snapshot and a field change', async () => {
    const u = await signUpUser(app, `Hosted Capture ${Math.random().toString(36).slice(2, 8)}`);
    const as = (method: string, url: string, payload?: unknown) => call(app, u.token, method, url, payload);
    const w = (await as('POST', '/workspaces', { name: 'Hosted free capture' })).json().id as string;
    const space = (await as('GET', `/workspaces/${w}/spaces`)).json()[0].id;
    const db = (await as('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Things' })).json().id;
    const rec = (await as('POST', `/workspaces/${w}/databases/${db}/records`, { values: { name: 'before' } })).json().id as string;
    expect((await raw.select().from(billingSubscriptions).where(eq(billingSubscriptions.workspaceId, w))).length, 'premise: no billing row = Free').toBe(0);
    expect((await raw.select().from(recordVersions).where(eq(recordVersions.recordId, rec))).length, 'premise: a create captures no snapshot').toBe(0);
    const res = await as('PATCH', `/workspaces/${w}/databases/${db}/records/${rec}`, { values: { name: 'after' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await raw.select().from(recordVersions).where(eq(recordVersions.recordId, rec))).length, 'the snapshot of the pre-edit state').toBe(1);
    expect((await raw.select().from(recordFieldChanges).where(eq(recordFieldChanges.recordId, rec))).length, 'the field change').toBeGreaterThanOrEqual(1);
    const versions = await as('GET', `/workspaces/${w}/databases/${db}/records/${rec}/versions`);
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().data, 'and the version list returns it').toHaveLength(1);
  });
});
