import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automationJobs, automations, connections } from '../db/schema';
import { env } from '../config/env';
import { redactSecrets } from '../common/redact-secrets';
import { ProviderError } from '../common/provider-error';
import { MAX_ATTEMPTS, nextAttemptDelayMs } from '../common/backoff-schedule';
import { takeToken } from '../common/token-bucket';
import type { TokenBucketState } from '../common/token-bucket';
import { ConnectionsService } from '../connections/connections.service';
import { PROVIDER_REGISTRY } from '../connections/providers';
import { NotificationsService } from '../notifications/notifications.service';
import { MAX_FAILURES } from './constants';

type AutomationJobRow = typeof automationJobs.$inferSelect;

export type TimeoutClass = 'short' | 'long' | 'upload';

/** Per timeoutClass wall-clock budget for one executor call (Step 2 of MN-253's guide). */
export const TIMEOUT_MS: Record<TimeoutClass, number> = {
  short: 30_000,
  long: 15 * 60_000,
  upload: 60 * 60_000,
};

/** A connection failure trips the breaker at this many failures (Step 5) — the
 * same simple running-streak shape as automations.service.ts's own
 * MAX_FAILURES, reusing `connections.errorStreak` (which already resets to 0
 * on any success, per ConnectionsService.test()/refreshOne()) rather than
 * adding a second time-windowed column just to track "10 within 1h" exactly. */
const BREAKER_FAILURE_THRESHOLD = 10;
const BREAKER_OPEN_MS = 30 * 60_000;

/** 8KB cap on anything written to lastError/artifact (Step 6). */
const MAX_STORED_LEN = 8_000;

export interface JobHelpers {
  /** Decrypted auth for a connection, via ConnectionsService — never the sealed
   * ciphertext. Callers cast `auth` to their provider's own auth shape (e.g.
   * `ResendAuth`) — this stays `unknown` because the runner has no way to know
   * which provider a given kind talks to. */
  connectionAuth(connectionId: string): Promise<{ provider: string; auth: unknown }>;
  fetcher: typeof fetch;
  /** Forward this to the provider's own idempotency mechanism where it has one
   * (e.g. Stripe/LinkedIn's `Idempotency-Key`) — our own ON CONFLICT DO NOTHING
   * only guarantees one JOB ROW per key, not one provider call. See job-runner
   * .service.ts's module doc for why that distinction matters. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export type JobExecutor = (payload: Record<string, unknown>, helpers: JobHelpers) => Promise<unknown>;

interface ExecutorEntry {
  fn: JobExecutor;
  timeoutClass: TimeoutClass;
}

export interface EnqueueInput {
  workspaceId: string;
  ruleId: string | null;
  runId: string | null;
  connectionId?: string | null;
  actionIndex: number;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  timeoutClass?: TimeoutClass;
}

/** `ruleId`/`recordId` may be absent (a webhook_received rule has no record;
 * a job enqueued outside a rule run has no rule) — 'norule'/'norecord'
 * placeholders keep the key stable and collision-free either way. */
export function buildIdempotencyKey(input: {
  ruleId: string | null;
  recordId: string | null;
  runId: string;
  actionIndex: number;
}): string {
  return `${input.ruleId ?? 'norule'}:${input.recordId ?? 'norecord'}:${input.runId}:${input.actionIndex}`;
}

function sanitizeError(message: string): string {
  const redacted = redactSecrets(message);
  return redacted.length > MAX_STORED_LEN ? redacted.slice(0, MAX_STORED_LEN) : redacted;
}

function sanitizeArtifact(result: unknown): unknown {
  const redacted = redactSecrets(result);
  const json = JSON.stringify(redacted) ?? 'null';
  if (json.length <= MAX_STORED_LEN) return redacted;
  return { truncated: true, preview: json.slice(0, MAX_STORED_LEN) };
}

/**
 * MN-253 — the durable action-job queue's worker. Claims queued rows with
 * `SELECT … FOR UPDATE SKIP LOCKED` (safe under multiple replicas, same tool
 * automations.service.ts's scheduler uses an advisory lock for), runs the
 * kind's registered executor with a per-timeoutClass AbortController, and
 * applies backoff retries + a per-connection circuit breaker + rate limit.
 *
 * ## What "idempotency" does and doesn't cover here
 *
 * `idempotencyKey` is UNIQUE on `automation_jobs`, so `enqueue()`'s `INSERT …
 * ON CONFLICT DO NOTHING` guarantees exactly one JOB ROW per rule/record/run/
 * action-index — a duplicate enqueue call (e.g. a retried HTTP request at some
 * upstream layer) never creates a second row. Combined with the retry loop
 * re-running the SAME row (attempts increments in place; a claimed job is
 * never re-inserted), this is what the forced-retry test in job-runner
 * .service.test.ts verifies: exactly one artifact, attempts=2.
 *
 * What this does NOT do: guarantee a provider is called at-most-once across a
 * hard crash between "provider call succeeded" and "we wrote status=succeeded"
 * — the reaper would revert that stuck 'running' row back to 'queued' and it
 * would run again, calling the provider a second time. Closing that gap needs
 * the provider's OWN idempotency support (many do — Stripe, LinkedIn's content
 * API); that's why `idempotencyKey` is hand to every executor via `helpers` for
 * it to forward. This is documented, not silently assumed — see the PR
 * description's "known limitation" note.
 */
@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private executors = new Map<string, ExecutorEntry>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connections: ConnectionsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.tick(), 5_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── executor registry ────────────────────────────────────────────────────

  /** Provider modules (MN-256/257/258/259/263) call this at bootstrap. */
  registerExecutor(kind: string, fn: JobExecutor, opts?: { timeoutClass?: TimeoutClass }): void {
    this.executors.set(kind, { fn, timeoutClass: opts?.timeoutClass ?? 'short' });
  }

  /** actions.service.ts's execute() routes a kind through the queue instead of
   * running it inline exactly when this is true. */
  hasExecutor(kind: string): boolean {
    return this.executors.has(kind);
  }

  // ── enqueue ──────────────────────────────────────────────────────────────

  async enqueue(input: EnqueueInput): Promise<{ jobId: string; status: string }> {
    const timeoutClass = input.timeoutClass ?? this.executors.get(input.kind)?.timeoutClass ?? 'short';
    const [inserted] = await this.db
      .insert(automationJobs)
      .values({
        workspaceId: input.workspaceId,
        ruleId: input.ruleId,
        runId: input.runId,
        connectionId: input.connectionId ?? null,
        actionIndex: input.actionIndex,
        kind: input.kind,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        timeoutClass,
      })
      .onConflictDoNothing({ target: automationJobs.idempotencyKey })
      .returning({ id: automationJobs.id, status: automationJobs.status });
    if (inserted) return { jobId: inserted.id, status: inserted.status };
    // Conflict: a job with this key already exists — return it as-is rather
    // than enqueue a second attempt at the same logical action.
    const existing = await this.db.query.automationJobs.findFirst({
      where: eq(automationJobs.idempotencyKey, input.idempotencyKey),
      columns: { id: true, status: true },
    });
    // The unique constraint just fired, so a row is guaranteed to exist; this
    // fallback only matters if it's deleted between the conflict and this read.
    return existing ? { jobId: existing.id, status: existing.status } : { jobId: '', status: 'unknown' };
  }

  // ── worker loop ──────────────────────────────────────────────────────────

  /** One worker pass — public so tests can invoke it directly instead of
   * waiting on the 5s timer (mirrors AutomationsService.tick()). */
  async tick(): Promise<void> {
    await this.reap();
    const claimed = await this.claimBatch();
    for (const job of claimed) {
      await this.processClaimedJob(job);
    }
  }

  /** Restart survival (Step: reaper): a job stuck 'running' past its
   * timeoutClass's budget — the API died mid-execution — reverts to 'queued'
   * with attempts unchanged, so the next tick (this process or a fresh one
   * after a restart) picks it up again. */
  private async reap(): Promise<void> {
    for (const timeoutClass of Object.keys(TIMEOUT_MS) as TimeoutClass[]) {
      const cutoff = new Date(Date.now() - TIMEOUT_MS[timeoutClass]);
      await this.db
        .update(automationJobs)
        .set({ status: 'queued', startedAt: null })
        .where(
          and(
            eq(automationJobs.status, 'running'),
            eq(automationJobs.timeoutClass, timeoutClass),
            lte(automationJobs.startedAt, cutoff),
          ),
        );
    }
  }

  private async claimBatch(limit = 10): Promise<AutomationJobRow[]> {
    const result = (await this.db.execute(sql`
      UPDATE automation_jobs
      SET status = 'running', started_at = now()
      WHERE id IN (
        SELECT id FROM automation_jobs
        WHERE status = 'queued' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    const ids = result.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.query.automationJobs.findMany({ where: inArray(automationJobs.id, ids) });
  }

  private async processClaimedJob(job: AutomationJobRow): Promise<void> {
    // ── circuit breaker + rate limit gating, BEFORE bumping attempts — a
    // breaker-open or rate-limited job is rescheduled, not a failed attempt. ──
    if (job.connectionId) {
      const connection = await this.db.query.connections.findFirst({
        where: eq(connections.id, job.connectionId),
      });
      if (!connection) {
        await this.finalizeNonRetryable(job, 'connection no longer exists');
        return;
      }
      if (connection.breakerOpenUntil && connection.breakerOpenUntil > new Date()) {
        await this.releaseWithoutAttempt(job, connection.breakerOpenUntil);
        return;
      }
      const rateLimit = PROVIDER_REGISTRY.get(connection.provider)?.rateLimit;
      if (rateLimit) {
        const { allowed, state } = takeToken(
          connection.connectionRateState as TokenBucketState | null,
          rateLimit,
        );
        await this.db
          .update(connections)
          .set({ connectionRateState: state })
          .where(eq(connections.id, connection.id));
        if (!allowed) {
          const msPerToken = rateLimit.refillMs / rateLimit.capacity;
          await this.releaseWithoutAttempt(job, new Date(Date.now() + Math.max(1_000, msPerToken)));
          return;
        }
      }
    }

    const executor = this.executors.get(job.kind);
    if (!executor) {
      // No provider module registered this kind (or it was deregistered) —
      // not retryable, retrying can't make an executor appear.
      await this.finalizeNonRetryable(job, `no executor registered for kind "${job.kind}"`);
      return;
    }

    const attempts = job.attempts + 1;
    await this.db.update(automationJobs).set({ attempts }).where(eq(automationJobs.id, job.id));

    const timeoutMs = TIMEOUT_MS[executor.timeoutClass];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await executor.fn(job.payload as Record<string, unknown>, {
        connectionAuth: (connectionId) => this.connections.getDecryptedAuth(job.workspaceId, connectionId),
        fetcher: fetch,
        idempotencyKey: job.idempotencyKey,
        signal: controller.signal,
      });
      await this.finalizeSuccess(job, result);
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(error instanceof Error ? error.message : String(error), {
              retryable: timedOut,
            });
      await this.handleFailure(job, attempts, providerError);
    } finally {
      clearTimeout(timer);
    }
  }

  private async finalizeSuccess(job: AutomationJobRow, result: unknown): Promise<void> {
    await this.db
      .update(automationJobs)
      .set({ status: 'succeeded', artifact: sanitizeArtifact(result), lastError: null })
      .where(eq(automationJobs.id, job.id));
    if (job.connectionId) {
      await this.db
        .update(connections)
        .set({ errorStreak: 0, status: 'active', lastOkAt: new Date() })
        .where(eq(connections.id, job.connectionId));
    }
  }

  /** A non-retryable failure with no attempt made yet (unknown kind, deleted
   * connection) — final immediately, doesn't touch the attempts counter. */
  private async finalizeNonRetryable(job: AutomationJobRow, message: string): Promise<void> {
    await this.db
      .update(automationJobs)
      .set({ status: 'failed', lastError: sanitizeError(message) })
      .where(eq(automationJobs.id, job.id));
    await this.onFinalFailure(job, message);
  }

  private async releaseWithoutAttempt(job: AutomationJobRow, nextAttemptAt: Date): Promise<void> {
    await this.db
      .update(automationJobs)
      .set({ status: 'queued', nextAttemptAt, startedAt: null })
      .where(eq(automationJobs.id, job.id));
  }

  private async handleFailure(job: AutomationJobRow, attempts: number, err: ProviderError): Promise<void> {
    const lastError = sanitizeError(err.message);
    if (job.connectionId) await this.bumpConnectionErrorStreak(job.connectionId);

    const scheduleDelay = nextAttemptDelayMs(attempts);
    const delay = err.retryable && scheduleDelay !== null ? (err.retryAfterMs ?? scheduleDelay) : null;

    if (delay !== null) {
      await this.db
        .update(automationJobs)
        .set({ status: 'queued', nextAttemptAt: new Date(Date.now() + delay), lastError, startedAt: null })
        .where(eq(automationJobs.id, job.id));
      return;
    }
    // Non-retryable, or MAX_ATTEMPTS (Step 3) reached — final.
    await this.db
      .update(automationJobs)
      .set({ status: 'failed', lastError })
      .where(eq(automationJobs.id, job.id));
    await this.onFinalFailure(job, lastError);
  }

  private async bumpConnectionErrorStreak(connectionId: string): Promise<void> {
    const [row] = await this.db
      .update(connections)
      .set({ errorStreak: sql`${connections.errorStreak} + 1`, status: 'error' })
      .where(eq(connections.id, connectionId))
      .returning({ errorStreak: connections.errorStreak });
    if (row && row.errorStreak >= BREAKER_FAILURE_THRESHOLD) {
      await this.db
        .update(connections)
        .set({ breakerOpenUntil: new Date(Date.now() + BREAKER_OPEN_MS) })
        .where(eq(connections.id, connectionId));
      this.logger.warn(`connection ${connectionId} circuit breaker opened after ${row.errorStreak} failures`);
    }
  }

  /** Failure policy (Step 5): a rule whose job kept failing gets the same
   * failureStreak/auto-disable treatment as its inline actions
   * (automations.service.ts runRule/runHookRule), plus a notification —
   * something an inline failure's caught-and-logged effect already surfaces
   * to the presser/dispatcher synchronously, but a queued job's failure never
   * otherwise reaches its owner. */
  private async onFinalFailure(job: AutomationJobRow, lastError: string): Promise<void> {
    if (!job.ruleId) return; // rule since deleted, or job enqueued outside a rule run
    const rule = await this.db.query.automations.findFirst({ where: eq(automations.id, job.ruleId) });
    if (!rule) return;
    const streak = rule.failureStreak + 1;
    await this.db
      .update(automations)
      .set({ failureStreak: streak, enabled: streak >= MAX_FAILURES ? false : undefined })
      .where(eq(automations.id, job.ruleId));
    if (streak < MAX_FAILURES) return;
    this.logger.warn(`automation ${job.ruleId} auto-disabled after ${streak} failures (job ${job.id})`);
    if (!rule.createdBy) return;
    await this.notifications
      .notify({
        workspaceId: job.workspaceId,
        actorId: rule.createdBy,
        type: 'automation_disabled',
        recipients: [rule.createdBy],
        snippet: `"${rule.name}" was disabled after ${streak} failed runs — last error: ${lastError}`,
        allowSelf: true,
      })
      .catch(() => undefined);
  }
}

export { MAX_ATTEMPTS };
