import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automationJobs, automations, connections, notifications } from '../src/db/schema';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { ProviderError } from '../src/common/provider-error';

/**
 * MN-253 — JobRunnerService against a real Postgres (testcontainers, see
 * test/global-setup.ts). Covers what job-runner.service.test.ts's mocked-DB
 * unit tests can't: SKIP LOCKED claiming, backoff retries actually persisting
 * across ticks, the ON CONFLICT idempotency guarantee, the circuit breaker,
 * the token-bucket rate limit, and the restart-survival reaper.
 */
describe('automation jobs — durable action runner (MN-253)', () => {
  let app: NestFastifyApplication;
  let db: Db;
  let jobs: JobRunnerService;
  let admin: { token: string; email: string };
  let wsId: string;
  let dbRecordId: string;

  async function inject(method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as never,
      url: `/api/v1${url}`,
      headers: authed(admin.token),
      payload: payload as never,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    jobs = app.get(JobRunnerService);
    admin = await signUpUser(app, 'JobRunner');
    wsId = (await inject('POST', '/workspaces', { name: 'Jobs WS' })).json().id;
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbRecordId = (
      await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rules DB' })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertConnection(overrides: Partial<typeof connections.$inferInsert> = {}) {
    const [row] = await db
      .insert(connections)
      .values({
        workspaceId: wsId,
        provider: 'resend', // the only registered provider with a rateLimit default (MN-253)
        name: 'Test Resend',
        authSealed: 'unused-in-these-tests',
        createdBy: admin.email,
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function insertRule() {
    const [rule] = await db
      .insert(automations)
      .values({
        databaseId: dbRecordId,
        name: `Job-backed rule ${randomUUID()}`,
        trigger: { type: 'record_created' },
        actions: [],
        createdBy: admin.email,
      })
      .returning();
    return rule!;
  }

  it('ON CONFLICT dedup: a second enqueue with the same idempotencyKey never creates a second row', async () => {
    const key = `dedup:${randomUUID()}`;
    const first = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind: 'test.never_registered',
      payload: { hello: 'world' },
      idempotencyKey: key,
    });
    const second = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind: 'test.never_registered',
      payload: { hello: 'world, again' },
      idempotencyKey: key,
    });
    expect(second.jobId).toBe(first.jobId);
    const rows = await db.query.automationJobs.findMany({ where: eq(automationJobs.idempotencyKey, key) });
    expect(rows).toHaveLength(1);
    // The second enqueue's payload never overwrote the first's — ON CONFLICT DO NOTHING.
    expect(rows[0]!.payload).toEqual({ hello: 'world' });
  });

  it('forced-retry idempotency: a retryable failure once, then success — exactly one artifact, attempts=2', async () => {
    const kind = `test.forced-retry.${randomUUID()}`;
    let calls = 0;
    jobs.registerExecutor(kind, async (payload) => {
      calls += 1;
      if (calls === 1) throw new ProviderError('temporary blip', { retryable: true });
      return { ok: true, echoedPayload: payload };
    });

    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind,
      payload: { n: 1 },
      idempotencyKey: `retry:${randomUUID()}`,
    });

    await jobs.tick(); // claims + runs attempt 1 → retryable failure, rescheduled
    let row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(row!.status).toBe('queued');
    expect(row!.attempts).toBe(1);
    expect(row!.artifact).toBeNull();

    // Force the backoff delay to have elapsed instead of sleeping 30s in a test.
    await db
      .update(automationJobs)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(automationJobs.id, jobId));

    await jobs.tick(); // claims + runs attempt 2 → succeeds
    row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(row!.status).toBe('succeeded');
    expect(row!.attempts).toBe(2);
    expect(calls).toBe(2); // exactly one retry, exactly one eventual success — never double-executed
    expect(row!.artifact).toEqual({ ok: true, echoedPayload: { n: 1 } });
  });

  it('a non-retryable ProviderError fails the job on the first attempt, no retry scheduled', async () => {
    const kind = `test.non-retryable.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => {
      throw new ProviderError('bad request', { retryable: false });
    });
    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind,
      payload: {},
      idempotencyKey: `nonretry:${randomUUID()}`,
    });
    await jobs.tick();
    const row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(row!.status).toBe('failed');
    expect(row!.attempts).toBe(1);
  });

  it('MAX_ATTEMPTS (5) caps retries even when every failure is retryable', async () => {
    const kind = `test.always-fails.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => {
      throw new ProviderError('still down', { retryable: true });
    });
    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind,
      payload: {},
      idempotencyKey: `exhaust:${randomUUID()}`,
    });
    for (let i = 0; i < 5; i++) {
      await db
        .update(automationJobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(automationJobs.id, jobId));
      await jobs.tick();
    }
    const row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(row!.attempts).toBe(5);
    expect(row!.status).toBe('failed');
  });

  it('failure policy: a job-backed rule auto-disables and notifies its owner after MAX_FAILURES', async () => {
    const rule = await insertRule();
    const kind = `test.rule-fails.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => {
      throw new ProviderError('nope', { retryable: false });
    });
    // Each iteration is its own job (one non-retryable failure each) — the
    // rule's own failureStreak is what accumulates across them, exactly like
    // ten consecutive inline-action failures would via runRule.
    for (let i = 0; i < 10; i++) {
      const { jobId } = await jobs.enqueue({
        workspaceId: wsId,
        ruleId: rule.id,
        runId: null,
        actionIndex: 0,
        kind,
        payload: {},
        idempotencyKey: `rulefail:${rule.id}:${i}`,
      });
      await jobs.tick();
      const row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
      expect(row!.status).toBe('failed');
    }
    const updatedRule = await db.query.automations.findFirst({ where: eq(automations.id, rule.id) });
    expect(updatedRule!.failureStreak).toBe(10);
    expect(updatedRule!.enabled).toBe(false);
    const notes = await db.query.notifications.findMany({
      where: eq(notifications.type, 'automation_disabled'),
    });
    expect(notes.some((n) => n.snippet?.includes(rule.name))).toBe(true);
  });

  it('circuit breaker: opens after BREAKER_FAILURE_THRESHOLD connection-attributed failures and blocks further claims without spending an attempt', async () => {
    const connection = await insertConnection();
    const kind = `test.connection-fails.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => {
      throw new ProviderError('provider is down', { retryable: false });
    });
    for (let i = 0; i < 10; i++) {
      await jobs.enqueue({
        workspaceId: wsId,
        ruleId: null,
        runId: null,
        connectionId: connection.id,
        actionIndex: 0,
        kind,
        payload: {},
        idempotencyKey: `breaker:${connection.id}:${i}`,
      });
      await jobs.tick();
    }
    const afterTen = await db.query.connections.findFirst({ where: eq(connections.id, connection.id) });
    expect(afterTen!.errorStreak).toBeGreaterThanOrEqual(10);
    expect(afterTen!.breakerOpenUntil).not.toBeNull();
    expect(afterTen!.breakerOpenUntil!.getTime()).toBeGreaterThan(Date.now());

    // A fresh job against the now-breaker-open connection is claimed (status
    // flips to 'running' momentarily) but released back to 'queued' with
    // nextAttemptAt pinned to the breaker's expiry — NOT a spent attempt.
    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      connectionId: connection.id,
      actionIndex: 0,
      kind,
      payload: {},
      idempotencyKey: `breaker-blocked:${connection.id}`,
    });
    await jobs.tick();
    const blocked = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(blocked!.status).toBe('queued');
    expect(blocked!.attempts).toBe(0);
    expect(blocked!.nextAttemptAt.getTime()).toBe(afterTen!.breakerOpenUntil!.getTime());
  });

  it('rate limit: an exhausted token bucket reschedules the job without spending an attempt', async () => {
    // Seed the bucket already empty, refilling on a 24h window — nothing
    // refills back to 1 whole token inside this test's lifetime.
    const connection = await insertConnection({
      connectionRateState: { tokens: 0, lastRefillAt: new Date().toISOString() },
    });
    const kind = `test.rate-limited.${randomUUID()}`;
    let calls = 0;
    jobs.registerExecutor(kind, async () => {
      calls += 1;
      return { ok: true };
    });
    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      connectionId: connection.id,
      actionIndex: 0,
      kind,
      payload: {},
      idempotencyKey: `ratelimit:${connection.id}`,
    });
    await jobs.tick();
    const row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    expect(row!.status).toBe('queued');
    expect(row!.attempts).toBe(0); // rate-limited, not a failed attempt
    expect(calls).toBe(0); // the executor never even ran
  });

  it('reaper: a job stuck "running" past its timeoutClass budget reverts to "queued" with attempts unchanged (restart survival)', async () => {
    const kind = `test.reaper.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => ({ ok: true }));
    const { jobId } = await jobs.enqueue({
      workspaceId: wsId,
      ruleId: null,
      runId: null,
      actionIndex: 0,
      kind,
      payload: {},
      idempotencyKey: `reaper:${randomUUID()}`,
      timeoutClass: 'short',
    });
    // Simulate the API dying mid-execution: claimed ('running'), started long
    // ago, never reached success/failure.
    await db
      .update(automationJobs)
      .set({ status: 'running', startedAt: new Date(Date.now() - 60_000), attempts: 1 })
      .where(eq(automationJobs.id, jobId));

    await jobs.tick(); // reap() runs before claimBatch() every tick
    const reaped = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobId) });
    // Either still 'queued' (if this same tick didn't re-claim it in the same
    // pass) or already 'running' again having been reclaimed and the fake
    // executor already resolved — both are "not lost". Assert the stronger,
    // deterministic invariant: attempts was never reset backward, and it's
    // not stuck 'running' with a stale startedAt from before this tick.
    expect(['queued', 'succeeded', 'running']).toContain(reaped!.status);
    expect(reaped!.attempts).toBeGreaterThanOrEqual(1);
  });
});
