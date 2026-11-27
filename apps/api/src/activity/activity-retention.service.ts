import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { env } from '../config/env';
import { billingSubscriptions } from '../db/schema';
import { EntitlementsService } from '../billing/entitlements.service';
import type { PlanId } from '../billing/plans';
import { budgetPeriod } from '../runners/agent-budget';

/**
 * Ticket #1024 — `activity_events` had no retention at all: 1.3M rows / 590 MB of a 912 MB production database, and the backup dump grew
 * from 25 MB to 192 MB in nine days. This is the purge. It touches `activity_events` and NOTHING else: the plan-gated version history
 * (`record_versions`, `record_field_changes`, ADR version-history.md) is a different table with its own, much shorter, clock.
 *
 * HOW LONG (Ievgen's ruling, ticket #1385, 2026-11-27, replacing ticket #1024's 7/30/30/90): PER PLAN, read from the workspace's plan (`billing_subscriptions.plan`, no row =
 * Free: the same reading `BillingService.getStatus` does). The values are {@link ACTIVITY_RETENTION_DAYS_BY_PLAN}, the one place to
 * change them. A deployment WITHOUT a plan notion (self-hosted, Stripe off) has no plan to read: it uses `ACTIVITY_EVENTS_RETENTION_DAYS`
 * (`never` / `0` keeps everything), and with the variable unset it keeps everything: nobody asked this operator's data to be deleted. A
 * plan the map does not know deletes NOTHING for that workspace (the CASE has no ELSE), so adding a plan without adding its row here
 * keeps data instead of losing it. A no-card trial that has elapsed but was not yet lazily downgraded still reads as its trial plan,
 * which keeps longer, never shorter. ENTERPRISE IS `null` = KEPT FOREVER: it has no WHEN branch, so its rows are never selected (the same
 * "NULL cutoff deletes nothing" reading as an unknown plan, but on purpose and named).
 *
 * WHEN THE PURGE MAY START: {@link PURGE_NOT_BEFORE}. Every call to `purge()` (the scheduler's and any direct one) deletes nothing while
 * its clock is before that instant, and says so (`held: true`). It runs DAILY, not hourly.
 *
 * WHAT EXPIRES, and what does not (every line below is a reader that was found, not guessed):
 *   - EXPIRES at the plan value: an event about a record (`record_id` set: record.created/updated/deleted, relation.*, reference.created,
 *     comment.created, document.edited, attachment.added, button.pressed) and the `outward.*` agent log (`record_id` null).
 *   - KEPT FOREVER: an event with no `record_id` that is not `outward.*`: space/database/view deleted or restricted, portal links,
 *     runner pairing. Low volume, and what an audit log exists to answer. The rule is "no record", not a list of type names, so an
 *     audit type added next year is kept by default.
 *   - KEPT: a `record.updated` whose diff touches a person field. My Work's "assigned by" reads the LAST such event
 *     (search/my-work.service.ts); purging it would drop an old, still-open record out of "Assigned by me".
 *
 * THE SYSTEM FLOOR sits BELOW the plan value: it can only keep a row LONGER than the plan says, never delete one earlier.
 *   1. An `outward.*` row from the CURRENT CALENDAR MONTH (UTC) is kept: the agent budget sums exactly those (runners/agent-budget.service.ts).
 *   2. A row the webhook dispatcher has not passed yet is kept: any row newer than `cursor_at - WEBHOOK_SCAN_LOOKBACK_SECONDS` of an ENABLED
 *      subscription of its workspace. Deliberately not narrowed by the subscription's event types or database: keeping a little extra is
 *      free, deleting an undelivered event is not. A DISABLED subscription is not counted (the dispatcher skips it, and one left off for
 *      months must not pin a workspace's whole history forever).
 *
 * HOW IT DELETES: batches, never one giant DELETE. Each batch picks its rows `FOR UPDATE SKIP LOCKED`, so two nodes (or two
 * overlapping calls) take disjoint rows: nothing is deleted twice, nothing waits, nothing deadlocks. The walk also advances a
 * (created_at, id) pointer so the kept rows (which stay at the old end of the index) are passed once per run, not re-read by every
 * batch. That one is a cost measure only: with the pointer removed the results are identical (checked by mutation), so no test can
 * assert it. Logs counts, never row data.
 */
/** Days of record-level activity a hosted workspace keeps, by plan (ticket #1385). `null` = kept forever: the purge skips that plan entirely. */
export const ACTIVITY_RETENTION_DAYS_BY_PLAN: Record<PlanId, number | null> = { free: 30, pro: 365, business: 1095, enterprise: null };
/**
 * Ievgen's ruling (ticket #1385, 2026-11-27): the purge must not delete anything before this instant. It is checked at the top of
 * `purge()`, so the scheduler and every direct call pass through it, against the same clock the cutoffs use (`PurgeOptions.now`).
 * It exists so the new, much longer windows are in place and visible for a month before the first deletion on a production database
 * that has never been purged. Once that date has passed it does nothing and can be deleted, together with its tests ("not before").
 */
export const PURGE_NOT_BEFORE = new Date('2026-12-27T00:00:00Z');
export const PURGE_BATCH_SIZE = 5_000;
/** One run stops here and the next tick continues: a first run over millions of rows must not hold a node for minutes. */
export const MAX_BATCHES_PER_RUN = 400;
const PAUSE_BETWEEN_BATCHES_MS = 100;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `undefined`/empty/`never`/`0` = keep everything (null); a whole number = that many days. Anything else throws. */
export function parseRetentionDays(raw: string | undefined): number | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'never' || /^0+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ACTIVITY_EVENTS_RETENTION_DAYS must be a whole number of days, 0, or "never" (got "${raw}")`);
  return n;
}

export type PurgeOptions = {
  /** The clock. Defaults to now; tests fix it. It is ALSO what the {@link PURGE_NOT_BEFORE} gate is judged by. */
  now?: Date;
  /** TEST SEAM for the gate: the instant before which nothing is deleted. Defaults to {@link PURGE_NOT_BEFORE}; nothing in `src` passes it. */
  notBefore?: Date;
  /** One value for EVERY workspace, overriding both the plan and the environment. `null` = keep everything. The floors still apply. */
  retentionDays?: number | null;
  /** Force the per-plan (true) or the environment (false) path; by default hosted (Stripe on) is per plan and self-hosted reads the env. */
  perPlan?: boolean;
  batchSize?: number;
  maxBatches?: number;
  pauseMs?: number;
};
/** `disabled`: there is nothing to apply (retention off / every plan kept forever). `held`: the clock is before {@link PURGE_NOT_BEFORE}. */
export type PurgeResult = { deleted: number; batches: number; capped: boolean; disabled: boolean; held: boolean };

@Injectable()
export class ActivityRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityRetentionService.name);
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    if (!this.entitlements.hostedPlans && parseRetentionDays(env().ACTIVITY_EVENTS_RETENTION_DAYS) === null) {
      this.logger.log('activity_events retention is off (ACTIVITY_EVENTS_RETENTION_DAYS unset, 0 or never): nothing is purged');
      return;
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

  /** The retention each row is judged by, as a SQL timestamp expression, and the newest cutoff in play (for the index range). */
  private cutoffs(opts: PurgeOptions, now: Date): { expr: SQL; newest: string } | null {
    const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    const flat = opts.retentionDays !== undefined ? opts.retentionDays : opts.perPlan === true || (opts.perPlan === undefined && this.entitlements.hostedPlans) ? undefined : parseRetentionDays(env().ACTIVITY_EVENTS_RETENTION_DAYS);
    if (flat === null) return null;
    if (flat !== undefined) return { expr: sql`${at(flat)}::timestamptz`, newest: at(flat) };
    // A plan with `null` days (Enterprise) gets NO branch: kept forever.
    const finite = (Object.entries(ACTIVITY_RETENTION_DAYS_BY_PLAN) as Array<[PlanId, number | null]>).filter((e): e is [PlanId, number] => e[1] !== null);
    if (finite.length === 0) return null;
    const whens = finite.map(([plan, days]) => sql`WHEN ${plan} THEN ${at(days)}::timestamptz`);
    return {
      // No ELSE: a plan this map does not know, or keeps forever, yields NULL, `created_at < NULL` is never true, nothing of that workspace is deleted.
      expr: sql`(CASE COALESCE(bs.plan::text, 'free') ${sql.join(whens, sql` `)} END)`,
      newest: at(Math.min(...finite.map(([, days]) => days))),
    };
  }

  /**
   * How many days of record-level activity this workspace keeps: its plan's value on a hosted deployment, the environment value
   * elsewhere. `null` = kept forever. This is what the audit log reports as `retention_days`, so the number a reader is shown and the
   * number the purge applies cannot come from two places.
   */
  async retentionDaysFor(workspaceId: string): Promise<number | null> {
    if (!this.entitlements.hostedPlans) return parseRetentionDays(env().ACTIVITY_EVENTS_RETENTION_DAYS);
    const row = await this.db.query.billingSubscriptions.findFirst({ where: eq(billingSubscriptions.workspaceId, workspaceId), columns: { plan: true } });
    return ACTIVITY_RETENTION_DAYS_BY_PLAN[row?.plan ?? 'free'] ?? null;
  }

  /** Delete expired `activity_events` in batches. Returns counts only. Safe to call concurrently and repeatedly. */
  async purge(opts: PurgeOptions = {}): Promise<PurgeResult> {
    const now = opts.now ?? new Date();
    if (now.getTime() < (opts.notBefore ?? PURGE_NOT_BEFORE).getTime()) {
      this.logger.log(`activity_events purge held: nothing is deleted before ${(opts.notBefore ?? PURGE_NOT_BEFORE).toISOString()}`);
      return { deleted: 0, batches: 0, capped: false, disabled: false, held: true };
    }
    const cutoffs = this.cutoffs(opts, now);
    if (!cutoffs) return { deleted: 0, batches: 0, capped: false, disabled: true, held: false };
    const monthStart = budgetPeriod(now).startsAt.toISOString();
    const lookback = env().WEBHOOK_SCAN_LOOKBACK_SECONDS;
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
          LEFT JOIN billing_subscriptions bs ON bs.workspace_id = e.workspace_id
          WHERE e.created_at < ${cutoffs.newest}::timestamptz
            AND e.created_at < ${cutoffs.expr}
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
            AND NOT (e.type LIKE 'outward.%' AND e.created_at >= ${monthStart}::timestamptz)
            AND NOT EXISTS (
              SELECT 1 FROM webhook_subscriptions w
              WHERE w.workspace_id = e.workspace_id AND w.enabled
                AND e.created_at > w.cursor_at - make_interval(secs => ${lookback})
            )
          ORDER BY e.created_at, e.id
          LIMIT ${batchSize}
          FOR UPDATE OF e SKIP LOCKED
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
      this.logger.log(`activity_events purge: deleted ${deleted} rows in ${batches} batches${capped ? ` (stopped at ${maxBatches} batches; the next run continues)` : ''}`);
    }
    return { deleted, batches, capped, disabled: false, held: false };
  }
}
