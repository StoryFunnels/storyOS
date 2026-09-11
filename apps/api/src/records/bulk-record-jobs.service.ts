import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { bulkRecordJobs } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { env } from '../config/env';
import { RecordsService } from './records.service';

type BulkRecordJobRow = typeof bulkRecordJobs.$inferSelect;
type BulkOp = 'update' | 'delete';

/** A stuck 'running' job (the process died mid-chunk) reverts to 'queued'
 *  after this long, same convention as JobRunnerService's reaper. Generous
 *  relative to a single 200-record chunk, which normally completes in
 *  seconds. */
const REAP_AFTER_MS = 2 * 60_000;

/** #653's own chunk size — matching it means one job "chunk" (one tick, one
 *  DB round trip through batchUpdate/batchDelete) is exactly one of THEIR
 *  internal sub-chunks, not a second, differently-sized unit to reason
 *  about. */
const JOB_CHUNK_SIZE = 200;

export interface BulkRecordJobStatus {
  id: string;
  status: string;
  op: BulkOp;
  total: number;
  processed: number;
  succeeded: number;
  failed: Array<{ record_id: string; message: string }>;
  restorable: Array<{ record_id: string; version_id: string }>;
}

function toStatus(job: BulkRecordJobRow): BulkRecordJobStatus {
  const recordIds = job.recordIds as string[];
  return {
    id: job.id,
    status: job.status,
    op: job.op as BulkOp,
    total: recordIds.length,
    processed: job.cursor,
    succeeded: job.succeeded,
    failed: job.failed as Array<{ record_id: string; message: string }>,
    restorable: job.restorable as Array<{ record_id: string; version_id: string }>,
  };
}

/**
 * #694 — durable bulk record operations. See schema.ts's own doc on
 * `bulkRecordJobs` for why this is a new mechanism rather than a reuse of
 * `automationJobs`/`JobRunnerService`.
 *
 * One job processes ONE chunk per `tick()` call (not the whole job), by
 * design: that is what makes a mid-run crash survivable. `processOneChunk`
 * delegates the actual mutation to `RecordsService.batchUpdate`/
 * `batchDelete` with a `JOB_CHUNK_SIZE`-sized slice — the exact same
 * synchronous code path #653 already ships and tests, just orchestrated by
 * a background tick instead of a single HTTP request. Re-processing a
 * chunk after a crash (the reaper reverts the job before the chunk's
 * result was ever persisted) is safe for the same reason #653's own retry
 * story is: `update()` is a no-op difference when the value already
 * matches, so nothing double-applies.
 */
@Injectable()
export class BulkRecordJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkRecordJobsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.tick(), 2_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(
    workspaceId: string,
    databaseId: string,
    op: BulkOp,
    recordIds: string[],
    values: Record<string, unknown> | undefined,
    actorId: string,
    source: ChangeSource = 'human',
  ): Promise<BulkRecordJobStatus> {
    const [row] = await this.db
      .insert(bulkRecordJobs)
      .values({
        workspaceId,
        databaseId,
        actorId,
        source,
        op,
        recordIds,
        values: op === 'update' ? (values ?? {}) : null,
      })
      .returning();
    return toStatus(row!);
  }

  async get(workspaceId: string, jobId: string): Promise<BulkRecordJobStatus> {
    const row = await this.db.query.bulkRecordJobs.findFirst({
      where: eq(bulkRecordJobs.id, jobId),
    });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException('Job not found');
    return toStatus(row);
  }

  /** One worker pass — public so tests can invoke it directly instead of
   *  waiting on the 2s timer (mirrors JobRunnerService.tick()). */
  async tick(): Promise<void> {
    await this.reap();
    const job = await this.claimOne();
    if (!job) return;
    await this.processOneChunk(job);
  }

  private async reap(): Promise<void> {
    const cutoff = new Date(Date.now() - REAP_AFTER_MS);
    await this.db.execute(
      sql`UPDATE bulk_record_jobs SET status = 'queued', started_at = null WHERE status = 'running' AND started_at <= ${cutoff}`,
    );
  }

  private async claimOne(): Promise<BulkRecordJobRow | null> {
    const result = (await this.db.execute(sql`
      UPDATE bulk_record_jobs
      SET status = 'running', started_at = now()
      WHERE id IN (
        SELECT id FROM bulk_record_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    const id = result.rows[0]?.id;
    if (!id) return null;
    return (await this.db.query.bulkRecordJobs.findFirst({ where: eq(bulkRecordJobs.id, id) })) ?? null;
  }

  private async processOneChunk(job: BulkRecordJobRow): Promise<void> {
    const recordIds = job.recordIds as string[];
    const total = recordIds.length;
    const chunkIds = recordIds.slice(job.cursor, job.cursor + JOB_CHUNK_SIZE);
    const source = job.source as ChangeSource;

    let succeeded = job.succeeded;
    let failed = job.failed as Array<{ record_id: string; message: string }>;
    let restorable = job.restorable as Array<{ record_id: string; version_id: string }>;

    try {
      if (job.op === 'delete') {
        const result = await this.records.batchDelete(job.workspaceId, job.databaseId, chunkIds, job.actorId, source);
        succeeded += result.deleted;
      } else {
        const result = await this.records.batchUpdate(
          job.workspaceId,
          job.databaseId,
          chunkIds,
          (job.values as Record<string, unknown>) ?? {},
          job.actorId,
          source,
        );
        succeeded += result.updated;
        failed = [...failed, ...result.failed];
        restorable = [...restorable, ...result.restorable];
      }
    } catch (error) {
      // A whole-chunk failure (e.g. the database was deleted mid-run) fails
      // every id in this chunk explicitly rather than silently stalling the
      // job at the same cursor forever.
      const message = error instanceof Error ? error.message : 'chunk failed';
      failed = [...failed, ...chunkIds.map((record_id) => ({ record_id, message }))];
      this.logger.warn(`bulk record job ${job.id} chunk failed: ${message}`);
    }

    const newCursor = job.cursor + chunkIds.length;
    const done = newCursor >= total;
    const status = done ? (failed.length > 0 ? 'partially_failed' : 'succeeded') : 'queued';

    await this.db
      .update(bulkRecordJobs)
      .set({
        cursor: newCursor,
        succeeded,
        failed,
        restorable,
        status,
        startedAt: done ? job.startedAt : null, // back to 'queued' means available for the next claim
      })
      .where(eq(bulkRecordJobs.id, job.id));
  }
}
