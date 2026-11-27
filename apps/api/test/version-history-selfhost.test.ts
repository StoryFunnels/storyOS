import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { documentVersions, recordFieldChanges, recordVersions } from '../src/db/schema';
import { PURGE_NOT_BEFORE } from '../src/activity/activity-retention.service';
import { windowClock } from '../src/activity/history-window';
import { VersionHistoryRetentionService } from '../src/activity/version-history-retention.service';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { env } from '../src/config/env';

/**
 * Ticket #1386 — a deployment WITHOUT plans (self-hosted, Stripe off) has no plan window: the purge keeps everything and the list
 * and restore show everything, on any clock, however old. Nobody asked this operator's history to be deleted.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
const DAY = 24 * 60 * 60 * 1000;
const LATE = new Date(PURGE_NOT_BEFORE.getTime() + 400 * DAY);

beforeAll(async () => {
  app = await createTestApp();
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('self-hosted keeps everything', () => {
  it('premise: this deployment really has no plans', () => {
    expect(app.get(EntitlementsService).hostedPlans).toBe(false);
  });

  it('the default purge, long after the not-before date, deletes nothing from any of the three tables and says it is disabled', async () => {
    const u = await signUpUser(app, 'Selfhost Owner');
    const as = (m: string, url: string, p?: unknown) => call(app, u.token, m, url, p);
    const ws = (await as('POST', '/workspaces', { name: 'Self' })).json().id as string;
    const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'T' })).json().id as string;
    const rec = (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'r' } })).json().id as string;
    const ancient = new Date('2015-01-01T00:00:00Z');
    const v = (await raw.insert(recordVersions).values([{ workspaceId: ws, recordId: rec, title: 'a', values: {}, createdAt: ancient }, { workspaceId: ws, recordId: rec, title: 'b', values: {}, createdAt: new Date(ancient.getTime() + DAY) }]).returning({ id: recordVersions.id })).map((r) => r.id);
    const c = (await raw.insert(recordFieldChanges).values({ workspaceId: ws, databaseId: db, recordId: rec, fieldId: null, createdAt: ancient }).returning({ id: recordFieldChanges.id })).map((r) => r.id);
    const d = (await raw.insert(documentVersions).values([{ workspaceId: ws, recordId: rec, content: [], version: 1, createdAt: ancient }, { workspaceId: ws, recordId: rec, content: [], version: 2, createdAt: new Date(ancient.getTime() + DAY) }]).returning({ id: documentVersions.id })).map((r) => r.id);

    const out = await app.get(VersionHistoryRetentionService).purge({ now: LATE, pauseMs: 0 });
    expect(out).toMatchObject({ deleted: 0, disabled: true, held: false });
    expect((await raw.select({ id: recordVersions.id }).from(recordVersions).where(inArray(recordVersions.id, v))).length).toBe(2);
    expect((await raw.select({ id: recordFieldChanges.id }).from(recordFieldChanges).where(inArray(recordFieldChanges.id, c))).length).toBe(1);
    expect((await raw.select({ id: documentVersions.id }).from(documentVersions).where(inArray(documentVersions.id, d))).length).toBe(2);

    // And the READ side shows all of it, on a clock a year past the date: no window to filter by.
    const prevClock = windowClock.now;
    windowClock.now = () => LATE;
    try {
      const list = await as('GET', `/workspaces/${ws}/databases/${db}/records/${rec}/versions`);
      expect(list.json().data.map((x: { id: string }) => x.id).sort()).toEqual([...v].sort());
      const restore = await as('POST', `/workspaces/${ws}/databases/${db}/records/${rec}/versions/${v[0]}/restore`);
      expect(restore.statusCode, restore.body).toBe(201);
      const changes = await as('GET', `/workspaces/${ws}/databases/${db}/records/${rec}/versions/changes`);
      expect(changes.json().data.length).toBeGreaterThanOrEqual(1);
    } finally {
      windowClock.now = prevClock;
    }
  });

  it('the scheduler is not started at all (nothing to apply)', async () => {
    const svc = app.get(VersionHistoryRetentionService);
    const purge = vi.spyOn(svc, 'purge');
    const e = env() as unknown as Record<string, string | undefined>;
    const prev = e.NODE_ENV;
    e.NODE_ENV = 'production'; // onModuleInit returns early under 'test', which would make this pass for the wrong reason
    vi.useFakeTimers();
    try {
      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
      expect(purge).not.toHaveBeenCalled();
    } finally {
      e.NODE_ENV = prev;
      svc.onModuleDestroy();
      purge.mockRestore();
      vi.useRealTimers();
    }
  });
});
