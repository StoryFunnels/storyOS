import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { env } from '../config/env';

/**
 * Ticket #1024 — `activity_events` had no retention at all: 1.3M rows / 590 MB of a 912 MB production database, and the backup dump
 * grew from 25 MB to 192 MB in nine days. This is the purge. It touches `activity_events` and NOTHING else: the plan-gated version
 * history (`record_versions`, `record_field_changes`, ADR version-history.md) is a different table with its own, much shorter, clock.
 *
 * WHAT EXPIRES, and what does not (decided on the ticket; every line below is a reader that was found, not guessed):
 *   - EXPIRES: an event about a record (`record_id` set: record.created/updated/deleted, relation.*, reference.created, comment.created,
 *     document.edited, attachment.added, button.pressed) and the `outward.*` agent log (high volume, `record_id` null).
 *   - KEPT FOREVER: an event with no `record_id` that is not `outward.*`: space/database/view deleted or restricted, portal links,
 *     runner pairing. They are low volume and they are what an audit log exists to answer. The rule is "no record", not a list of
 *     type names, so an audit type added next year is kept by default; a list would purge it the day nobody remembered to extend it.
 *   - KEPT: a `record.updated` whose diff touches a person field. My Work's "assigned by" / "assigned by me" reads the LAST such event
 *     (search/my-work.service.ts); purging it would drop an old, still-open record out of "Assigned by me". Person-field changes are a
 *     tiny share of the volume.
 *
 * WHY A FLOOR: the agent budget sums this calendar month's `outward.ai_field` rows, and the webhook dispatcher re-reads behind its
 * cursor. A retention under a month would make a budget quietly under-count. So no setting goes below {@link MIN_RETENTION_DAYS}.
 *
 * HOW IT DELETES: batches, never one giant DELETE. Each batch picks its rows `FOR UPDATE SKIP LOCKED`, so two nodes (or two
 * overlapping calls) take disjoint rows: nothing is deleted twice, nothing waits, nothing deadlocks. The walk also advances a
 * (created_at, id) pointer so the kept rows (which stay at the old end of the index) are passed once per run, not re-read by every
 * batch. That one is a cost measure only: with the pointer removed the results are identical (checked by mutation), so no test can
 * assert it. Logs counts, never row data.
 */
export const DEFAULT_RETENTION_DAYS = 90;
/** A month's budget plus the longest webhook lookback, with slack. Not configurable below this. */
export const MIN_RETENTION_DAYS = 35;
export const PURGE_BATCH_SIZE = 5_000;
/** One run stops here and the next tick continues: a first run over millions of rows must not hold a node for minutes. */
export const MAX_BATCHES_PER_RUN = 400;
const PAUSE_BETWEEN_BATCHES_MS = 100;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionSetting = { days: number | null; clamped: boolean };

/** `undefined`/empty = the default; `never` or `0` = keep forever (null); a number below the floor is raised to it and flagged. */
export function parseRetentionDays(raw: string | undefined): RetentionSetting {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return { days: DEFAULT_RETENTION_DAYS, clamped: false };
  if (v === 'never' || /^0+$/.test(v)) return { days: null, clamped: false };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ACTIVITY_EVENTS_RETENTION_DAYS must be a whole number of days, 0, or "never" (got "${raw}")`);
  return n < MIN_RETENTION_DAYS ? { days: MIN_RETENTION_DAYS, clamped: true } : { days: n, clamped: false };
}

export type PurgeOptions = {
  /** The clock. Defaults to now; tests fix it. */
  now?: Date;
  /** Overrides the environment. `null` = keep forever. Still subject to the floor. */
  retentionDays?: number | null;
  batchSize?: number;
  maxBatches?: number;
  pauseMs?: number;
};
export type PurgeResult = { deleted: number; batches: number; capped: boolean; disabled: boolean };

@Injectable()
export class ActivityRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityRetentionService.name);
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    const setting = parseRetentionDays(env().ACTIVITY_EVENTS_RETENTION_DAYS);
    if (setting.days === null) {
      this.logger.log('activity_events retention is off (ACTIVITY_EVENTS_RETENTION_DAYS=never): nothing is purged');
      return;
    }
    if (setting.clamped) {
      this.logger.warn(`ACTIVITY_EVENTS_RETENTION_DAYS is below the ${MIN_RETENTION_DAYS}-day floor (agent budgets read this month's events); using ${MIN_RETENTION_DAYS}`);
    }
    // Per node and per overlapping tick: skip a tick while the previous one is still walking. The purge itself is safe to run twice at once
    // (SKIP LOCKED), this only avoids a node competing with itself.
    const run = () => {
      if (this.running) return;
      this.running = true;
      void this.purge()
        .catch((error) => this.logger.warn(`activity_events purge failed: ${String(error)}`))
        .finally(() => {
          this.running = false;
        });
    };
    this.firstRun = setTimeout(run, FIRST_RUN_DELAY_MS);
    this.firstRun.unref();
    this.timer = setInterval(run, PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  /** Delete expired `activity_events` in batches. Returns counts only. Safe to call concurrently and repeatedly. */
  async purge(opts: PurgeOptions = {}): Promise<PurgeResult> {
    const configured = opts.retentionDays === undefined ? parseRetentionDays(env().ACTIVITY_EVENTS_RETENTION_DAYS).days : opts.retentionDays;
    if (configured === null) return { deleted: 0, batches: 0, capped: false, disabled: true };
    const days = Math.max(configured, MIN_RETENTION_DAYS);
    const now = opts.now ?? new Date();
    // Strictly older than the cutoff: an event exactly `days` old is kept.
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const batchSize = Math.max(1, opts.batchSize ?? PURGE_BATCH_SIZE);
    const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_RUN;
    const pauseMs = opts.pauseMs ?? PAUSE_BETWEEN_BATCHES_MS;

    let deleted = 0;
    let batches = 0;
    let lastTs = '-infinity';
    let lastId = '00000000-0000-0000-0000-000000000000';
    let capped = false;
    for (;;) {
      if (batches >= maxBatches) {
        capped = true;
        break;
      }
      const res = (await this.db.execute(sql`
        WITH picked AS MATERIALIZED (
          SELECT e.id, e.created_at
          FROM activity_events e
          WHERE e.created_at < ${cutoff}::timestamptz
            AND (e.created_at, e.id) > (${lastTs}::timestamptz, ${lastId}::uuid)
            AND (e.record_id IS NOT NULL OR e.type LIKE 'outward.%')
            AND NOT (
              e.type = 'record.updated'
              AND jsonb_typeof(e.payload -> 'diff') = 'object'
              AND EXISTS (
                SELECT 1 FROM jsonb_object_keys(e.payload -> 'diff') k
                WHERE k IN (SELECT f.id::text FROM fields f WHERE f.type = 'user')
              )
            )
          ORDER BY e.created_at, e.id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        ), gone AS (
          DELETE FROM activity_events a USING picked p WHERE a.id = p.id RETURNING a.id
        )
        SELECT (SELECT count(*) FROM gone)::int AS n,
               (SELECT created_at::text FROM picked ORDER BY created_at DESC, id DESC LIMIT 1) AS last_ts,
               (SELECT id::text FROM picked ORDER BY created_at DESC, id DESC LIMIT 1) AS last_id
      `)) as unknown as { rows: Array<{ n: number; last_ts: string | null; last_id: string | null }> };
      const row = res.rows[0];
      const n = Number(row?.n ?? 0);
      if (n === 0 || !row?.last_ts || !row.last_id) break;
      batches += 1;
      deleted += n;
      lastTs = row.last_ts;
      lastId = row.last_id;
      if (n < batchSize) break;
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    if (deleted > 0 || capped) {
      this.logger.log(
        `activity_events purge: deleted ${deleted} rows older than ${days} days in ${batches} batches${capped ? ` (stopped at ${maxBatches} batches; the next run continues)` : ''}`,
      );
    }
    return { deleted, batches, capped, disabled: false };
  }
}
