import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

// Before ANY import: a Stripe key is what makes this deployment "hosted". The real detection picks the per-plan path, nothing is mocked.
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_version_retention_detection';
});

import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { billingSubscriptions, documentVersions, recordFieldChanges, recordVersions } from '../src/db/schema';
import { env } from '../src/config/env';
import { PURGE_NOT_BEFORE } from '../src/activity/activity-retention.service';
import { VersionHistoryRetentionService } from '../src/activity/version-history-retention.service';
import { PLANS } from '../src/billing/plans';

/**
 * Ticket #1386 — the daily purge of `record_versions`, `record_field_changes` and `document_versions`. The windows are the plan
 * windows (`historyRetentionDays`), Enterprise included (1825, NOT forever); nothing is deleted before 2026-12-27 UTC; a deployment
 * without plans keeps everything (the self-hosted file); and the newest version of a record or document is the restore baseline and
 * is never deleted.
 */
const { db: raw, pool } = connectTestDb();
let app: NestFastifyApplication;
let service: VersionHistoryRetentionService;
const DAY = 24 * 60 * 60 * 1000;
/** The clock the purge judges by: after the gate, so the existing tests are about WHAT is deleted. The gate has its own describe (real default). */
const NOW = new Date(PURGE_NOT_BEFORE.getTime() + 30 * DAY);
const OPEN = new Date(0);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const run = (opts: Parameters<VersionHistoryRetentionService['purge']>[0] = {}) => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN, ...opts });

type Plan = 'free' | 'pro' | 'business' | 'enterprise';
async function newWs(plan: Plan) {
  const owner = await signUpUser(app, `Retention Owner ${Math.random().toString(36).slice(2, 8)}`);
  const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
  const ws = (await as('POST', '/workspaces', { name: `Retention ${plan}` })).json().id as string;
  if (plan !== 'free') await raw.insert(billingSubscriptions).values({ workspaceId: ws, plan });
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Things' })).json().id as string;
  const mk = async (name: string) => (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name } })).json().id as string;
  return { ws, db, rec: await mk('r1'), mk };
}
type Ws = Awaited<ReturnType<typeof newWs>>;
const version = async (w: Ws, rec: string, days: number) =>
  (await raw.insert(recordVersions).values({ workspaceId: w.ws, recordId: rec, title: 'SECRET-TITLE', values: {}, createdAt: ago(days) }).returning({ id: recordVersions.id }))[0]!.id;
const change = async (w: Ws, rec: string, days: number) =>
  (await raw.insert(recordFieldChanges).values({ workspaceId: w.ws, databaseId: w.db, recordId: rec, fieldId: null, oldValue: 'a', newValue: 'b', createdAt: ago(days) }).returning({ id: recordFieldChanges.id }))[0]!.id;
const docVersion = async (w: Ws, rec: string, days: number) =>
  (await raw.insert(documentVersions).values({ workspaceId: w.ws, recordId: rec, content: [], version: 1, createdAt: ago(days) }).returning({ id: documentVersions.id }))[0]!.id;
const presentV = async (xs: string[]) => new Set((await raw.select({ id: recordVersions.id }).from(recordVersions).where(inArray(recordVersions.id, xs))).map((r) => r.id));
const presentC = async (xs: string[]) => new Set((await raw.select({ id: recordFieldChanges.id }).from(recordFieldChanges).where(inArray(recordFieldChanges.id, xs))).map((r) => r.id));
const presentD = async (xs: string[]) => new Set((await raw.select({ id: documentVersions.id }).from(documentVersions).where(inArray(documentVersions.id, xs))).map((r) => r.id));

beforeAll(async () => {
  app = await createTestApp();
  service = app.get(VersionHistoryRetentionService);
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('what the purge deletes, per plan, from all three tables', () => {
  const plans: Array<[Plan, number]> = [['free', 14], ['pro', 270], ['business', 730], ['enterprise', 1825]];

  it('premise: the windows are the plan windows, Enterprise 1825 and not forever', () => {
    expect(plans.map(([p]) => PLANS[p].historyRetentionDays)).toEqual([14, 270, 730, 1825]);
  });

  for (const [plan, days] of plans) {
    it(`${plan} (${days} days): older rows go from all three tables, younger ones stay`, async () => {
      const w = await newWs(plan);
      // The newest record_versions / document_versions row of a record is kept (below), so each side gets a younger one to be older than.
      const newestV = await version(w, w.rec, 1);
      const oldV = await version(w, w.rec, days + 2);
      const keepV = await version(w, w.rec, days - 2);
      const oldC = await change(w, w.rec, days + 2);
      const keepC = await change(w, w.rec, days - 2);
      const newestD = await docVersion(w, w.rec, 1);
      const oldD = await docVersion(w, w.rec, days + 2);
      const keepD = await docVersion(w, w.rec, days - 2);
      const out = await run();
      expect(out).toMatchObject({ held: false, disabled: false });
      expect((await presentV([newestV, oldV, keepV])).has(oldV), `${plan} record_versions past ${days}`).toBe(false);
      expect((await presentV([newestV, oldV, keepV])).has(keepV)).toBe(true);
      expect((await presentC([oldC, keepC])).has(oldC), `${plan} record_field_changes past ${days}`).toBe(false);
      expect((await presentC([oldC, keepC])).has(keepC)).toBe(true);
      expect((await presentD([newestD, oldD, keepD])).has(oldD), `${plan} document_versions past ${days}`).toBe(false);
      expect((await presentD([newestD, oldD, keepD])).has(keepD)).toBe(true);
    });
  }

  it('Enterprise is NOT kept forever (the activity purge keeps Enterprise; this one deletes at 1825 days)', async () => {
    const w = await newWs('enterprise');
    const c = await change(w, w.rec, 2000);
    await run();
    expect((await presentC([c])).size).toBe(0);
  });

  it('the boundary is the instant: a row one second inside the window stays, one second outside goes', async () => {
    const w = await newWs('free');
    const inside = (await raw.insert(recordFieldChanges).values({ workspaceId: w.ws, databaseId: w.db, recordId: w.rec, fieldId: null, createdAt: new Date(NOW.getTime() - 14 * DAY + 1000) }).returning({ id: recordFieldChanges.id }))[0]!.id;
    const outside = (await raw.insert(recordFieldChanges).values({ workspaceId: w.ws, databaseId: w.db, recordId: w.rec, fieldId: null, createdAt: new Date(NOW.getTime() - 14 * DAY - 1000) }).returning({ id: recordFieldChanges.id }))[0]!.id;
    await run();
    expect(await presentC([inside, outside])).toEqual(new Set([inside]));
  });

  it('a workspace is judged by ITS plan: the same age is deleted for Free and kept for Pro', async () => {
    const free = await newWs('free');
    const pro = await newWs('pro');
    const f = await change(free, free.rec, 100);
    const p = await change(pro, pro.rec, 100);
    await run();
    expect(await presentC([f, p])).toEqual(new Set([p]));
  });
});

describe('the newest version of a record or document is the restore baseline and is never deleted', () => {
  it('record_versions: only the newest row of each record survives an age that would delete the rest; another record is judged on its own rows', async () => {
    const w = await newWs('free');
    const other = await w.mk('r2');
    const a1 = await version(w, w.rec, 400);
    const a2 = await version(w, w.rec, 300);
    const a3 = await version(w, w.rec, 200); // newest of w.rec, 200 days old, past Free's 14
    const b1 = await version(w, other, 500); // the only (so newest) row of the other record
    await run();
    expect(await presentV([a1, a2, a3, b1])).toEqual(new Set([a3, b1]));
  });

  it('document_versions: the same', async () => {
    const w = await newWs('free');
    const d1 = await docVersion(w, w.rec, 400);
    const d2 = await docVersion(w, w.rec, 200);
    await run();
    expect(await presentD([d1, d2])).toEqual(new Set([d2]));
  });

  it('record_field_changes has no baseline row: every change past the window goes, newest included', async () => {
    const w = await newWs('free');
    const c1 = await change(w, w.rec, 300);
    const c2 = await change(w, w.rec, 200);
    await run();
    expect((await presentC([c1, c2])).size).toBe(0);
  });

  it('a tie on created_at keeps exactly ONE row (the id breaks it), never none and never both', async () => {
    const w = await newWs('free');
    const at = ago(300);
    const rows = await raw.insert(recordVersions).values([
      { workspaceId: w.ws, recordId: w.rec, title: 't', values: {}, createdAt: at },
      { workspaceId: w.ws, recordId: w.rec, title: 't', values: {}, createdAt: at },
    ]).returning({ id: recordVersions.id });
    await run();
    expect((await presentV(rows.map((r) => r.id))).size).toBe(1);
  });
});

describe('the purge scan is served by a created_at index on each table (ticket #1386 follow-up)', () => {
  for (const [table, index] of [['record_versions', 'record_versions_created_idx'], ['record_field_changes', 'record_field_changes_created_idx'], ['document_versions', 'document_versions_created_idx']] as const) {
    it(`${table}: ${index} exists, leads with created_at, and the planner can use it for created_at < cutoff`, async () => {
      const def = await pool.query('SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2', [table, index]);
      expect(def.rows[0]?.indexdef, `${index} missing`).toMatch(/\(created_at\)$/);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = await client.query(`EXPLAIN SELECT id FROM ${table} WHERE created_at < now() - interval '14 days'`);
        expect(plan.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n')).toContain(index);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  }
});

describe('how it deletes', () => {
  it('walks in batches, stops at maxBatches and the next run continues', async () => {
    const w = await newWs('free');
    const all = [];
    for (let i = 0; i < 7; i++) all.push(await change(w, w.rec, 30 + i));
    const first = await run({ batchSize: 2, maxBatches: 2 });
    expect(first).toMatchObject({ deleted: 4, batches: 2, capped: true });
    expect((await presentC(all)).size).toBe(3);
    const second = await run({ batchSize: 2, maxBatches: 10 });
    expect(second).toMatchObject({ deleted: 3, capped: false });
    expect((await presentC(all)).size).toBe(0);
  });

  it('two overlapping runs take disjoint rows: together they delete each row exactly once and neither fails', async () => {
    const w = await newWs('free');
    const all: string[] = [];
    for (let i = 0; i < 12; i++) all.push(await change(w, w.rec, 30 + i));
    const [a, b] = await Promise.all([run({ batchSize: 3 }), run({ batchSize: 3 })]);
    expect(a.deleted + b.deleted, 'no row deleted twice (SKIP LOCKED), none missed').toBe(12);
    expect((await presentC(all)).size).toBe(0);
  });

  it('a row another transaction holds locked is SKIPPED, not waited for: the run finishes, the row survives, the next run takes it', async () => {
    const w = await newWs('free');
    const locked = await change(w, w.rec, 40);
    const free1 = await change(w, w.rec, 41);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM record_field_changes WHERE id = $1 FOR UPDATE', [locked]);
      const out = await Promise.race([run(), new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 5000))]);
      expect(out, 'without SKIP LOCKED the purge would wait here for the other transaction').not.toBe('blocked');
      expect(await presentC([locked, free1])).toEqual(new Set([locked]));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await run();
    expect((await presentC([locked])).size, 'taken once the lock is gone').toBe(0);
  });

  it('logs counts only, never a title or a value', async () => {
    const w = await newWs('free');
    await version(w, w.rec, 100);
    await version(w, w.rec, 101);
    const logs: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.includes('version history purge'));
    expect(line, logs.join('\n')).toMatch(/deleted \d+ rows/);
    expect(logs.join('\n')).not.toContain('SECRET-TITLE');
  });

  it('every call carries per-table counts', async () => {
    const w = await newWs('free');
    await change(w, w.rec, 100);
    const out = await run();
    expect(out.byTable.record_field_changes).toBeGreaterThanOrEqual(1);
    expect(Object.keys(out.byTable).sort()).toEqual(['document_versions', 'record_field_changes', 'record_versions']);
  });
});

describe('the scheduler is daily and only runs on a hosted deployment', () => {
  it('onModuleInit schedules a first run after a short delay, then once a day (not hourly)', async () => {
    const e = env() as unknown as Record<string, string | undefined>;
    vi.useFakeTimers();
    const purge = vi.spyOn(service, 'purge').mockResolvedValue({ deleted: 0, byTable: { record_versions: 0, record_field_changes: 0, document_versions: 0 }, batches: 0, capped: false, disabled: false, held: false });
    const before = e.NODE_ENV;
    e.NODE_ENV = 'production';
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(121_000);
      expect(purge, 'ran after the first-run delay').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purge, 'NOT again an hour later').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      expect(purge.mock.calls.length, 'and again once a day has passed').toBe(2);
    } finally {
      service.onModuleDestroy();
      e.NODE_ENV = before;
      purge.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('nothing is deleted before 2026-12-27 UTC', () => {
  // The REAL gate (no `notBefore` passed). A run dated Dec 27 judges every older row in the shared database, so this goes last.
  const before = new Date(PURGE_NOT_BEFORE.getTime() - 1);
  const at = (iso: string) => new Date(iso);

  it('a run dated one millisecond before it deletes nothing and says so; the same data goes on the first instant of the day', async () => {
    const w = await newWs('free');
    const keepNewest = await version(w, w.rec, 1);
    const oldV = (await raw.insert(recordVersions).values({ workspaceId: w.ws, recordId: w.rec, title: 'gate', values: {}, createdAt: at('2026-09-01T00:00:00Z') }).returning({ id: recordVersions.id }))[0]!.id;
    const oldC = (await raw.insert(recordFieldChanges).values({ workspaceId: w.ws, databaseId: w.db, recordId: w.rec, fieldId: null, createdAt: at('2026-09-01T00:00:00Z') }).returning({ id: recordFieldChanges.id }))[0]!.id;
    const oldD = (await raw.insert(documentVersions).values({ workspaceId: w.ws, recordId: w.rec, content: [], version: 1, createdAt: at('2026-09-01T00:00:00Z') }).returning({ id: documentVersions.id }))[0]!.id;
    const oldD2 = (await raw.insert(documentVersions).values({ workspaceId: w.ws, recordId: w.rec, content: [], version: 2, createdAt: at('2026-09-02T00:00:00Z') }).returning({ id: documentVersions.id }))[0]!.id;
    void keepNewest;
    const held = await service.purge({ now: before, pauseMs: 0 });
    expect(held).toMatchObject({ deleted: 0, batches: 0, capped: false, disabled: false, held: true });
    expect((await presentV([oldV])).size, 'record_versions: only the gate kept it').toBe(1);
    expect((await presentC([oldC])).size, 'record_field_changes').toBe(1);
    expect((await presentD([oldD, oldD2])).size, 'document_versions').toBe(2);
    const open = await service.purge({ now: PURGE_NOT_BEFORE, pauseMs: 0 });
    expect(open.held).toBe(false);
    expect((await presentC([oldC])).size, 'deleted on 2026-12-27 00:00:00 UTC').toBe(0);
    expect((await presentD([oldD, oldD2])).size, 'the older document version goes, the newer of the two is the baseline').toBe(1);
  });

  it('the SCHEDULER passes through the gate: a tick before the date deletes nothing, one after it deletes per plan', async () => {
    const e = env() as unknown as Record<string, string | undefined>;
    const w = await newWs('free');
    const purge = vi.spyOn(service, 'purge');
    const prev = e.NODE_ENV;
    e.NODE_ENV = 'production';
    try {
      for (const [clock, expectGone] of [[at('2026-12-26T12:00:00Z'), false], [at('2026-12-28T12:00:00Z'), true]] as const) {
        const row = (await raw.insert(recordFieldChanges).values({ workspaceId: w.ws, databaseId: w.db, recordId: w.rec, fieldId: null, createdAt: new Date(clock.getTime() - 40 * DAY) }).returning({ id: recordFieldChanges.id }))[0]!.id;
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
        vi.setSystemTime(clock);
        purge.mockClear();
        service.onModuleInit();
        await vi.advanceTimersByTimeAsync(121_000);
        service.onModuleDestroy();
        const result = await purge.mock.results[0]!.value;
        vi.useRealTimers();
        expect(result.held, `${clock.toISOString()}: held`).toBe(!expectGone);
        expect((await presentC([row])).size === 0, `${clock.toISOString()}: the Free row is ${expectGone ? 'deleted' : 'kept'}`).toBe(expectGone);
      }
    } finally {
      service.onModuleDestroy();
      e.NODE_ENV = prev;
      purge.mockRestore();
      vi.useRealTimers();
    }
  });
});
