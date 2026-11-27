import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { activityEvents } from '../src/db/schema';
import { env } from '../src/config/env';
import { ActivityRetentionService } from '../src/activity/activity-retention.service';
import { EntitlementsService } from '../src/billing/entitlements.service';

/**
 * Ticket #1024, Vera's blocker: the DEFAULT purge() and the scheduler (onModuleInit) on a SELF-HOSTED deployment, decided by the real
 * detection (no Stripe key in this suite), not by options passed in. The hosted counterpart is activity-retention-hosted.test.ts.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let service: ActivityRetentionService;
let ws: string;
let rec: string;
let ownerId: string;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
/** Existing tests are about WHAT the purge deletes; the not-before gate (PURGE_NOT_BEFORE, ticket #1385) has its own describe below and runs with the real default. */
const OPEN = new Date(0);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const seed = async (days: number) =>
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
/** Boots the timers with the variable at `value` and reports whether a purge ran after the first-run delay. */
const schedules = (value: string | undefined, nodeEnv = 'production') =>
  withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: value, NODE_ENV: nodeEnv }, async () => {
    vi.useFakeTimers();
    const purge = vi.spyOn(service, 'purge').mockResolvedValue({ deleted: 0, batches: 0, capped: false, disabled: false, held: false });
    try {
      service.onModuleInit();
      vi.advanceTimersByTime(61_000);
      return purge.mock.calls.length > 0;
    } finally {
      service.onModuleDestroy();
      purge.mockRestore();
      vi.useRealTimers();
    }
  });

beforeAll(async () => {
  app = await createTestApp();
  service = app.get(ActivityRetentionService);
  const u = await signUpUser(app, 'Selfhost Owner');
  ownerId = (await call(app, u.token, 'GET', '/me')).json().id;
  ws = (await call(app, u.token, 'POST', '/workspaces', { name: 'Selfhost WS' })).json().id;
  const space = (await call(app, u.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const db = (await call(app, u.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Things' })).json().id;
  rec = (await call(app, u.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'r' } })).json().id;
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('self-hosted (real detection)', () => {
  it('premise: this deployment is not hosted', () => {
    expect(app.get(EntitlementsService).hostedPlans).toBe(false);
  });

  it('purge() with no options reads the variable: N days applies', async () => {
    const old = await seed(61);
    const fresh = await seed(59);
    await withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: '60' }, () => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN }));
    expect((await present([old])).size).toBe(0);
    expect((await present([fresh])).size).toBe(1);
  });

  it('purge() with no options and the variable unset, 0 or never deletes nothing', async () => {
    const e = await seed(900);
    for (const v of [undefined, '0', 'never']) {
      const out = await withEnv({ ACTIVITY_EVENTS_RETENTION_DAYS: v }, () => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN }));
      expect(out, String(v)).toMatchObject({ deleted: 0, disabled: true });
    }
    expect((await present([e])).size).toBe(1);
  });

  it('onModuleInit schedules nothing when the variable is unset, 0 or never, and schedules when it is a number', async () => {
    expect(await schedules(undefined), 'unset').toBe(false);
    expect(await schedules('0'), '0').toBe(false);
    expect(await schedules('never'), 'never').toBe(false);
    expect(await schedules('30'), '30 days').toBe(true);
  });

  it('onModuleInit schedules nothing under NODE_ENV=test, whatever the variable says', async () => {
    expect(await schedules('30', 'test')).toBe(false);
  });
});
