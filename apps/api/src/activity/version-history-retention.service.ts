import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { env } from '../config/env';
import { EntitlementsService } from '../billing/entitlements.service';
import { PLANS } from '../billing/plans';
import type { PlanId } from '../billing/plans';
import { MAX_BATCHES_PER_RUN, PURGE_BATCH_SIZE, PURGE_NOT_BEFORE } from './activity-retention.service';

/**
 * Ticket #1386 — the purge of the plan-gated version history: `record_versions`, `record_field_changes` and `document_versions`.
 * `ActivityRetentionService` is the sibling for `activity_events` (a different table with its own, much longer clocks); this one
 * touches those three tables and nothing else.
 *
 * HOW LONG: the workspace's plan window, `PLANS[plan].historyRetentionDays` (Free 14, Pro 270, Business 730, Enterprise 1825),
 * read from `billing_subscriptions.plan` with no row = Free (the same reading `BillingService.getStatus` does). It is the SAME value
 * the capture gate and the list/restore filter use: nothing here has a number of its own. ENTERPRISE IS NOT FOREVER, unlike its
 * activity events: it has its own finite window (1825) and its own CASE branch. A plan this map does not know has no branch, so its
 * cutoff is NULL, `created_at < NULL` is never true and nothing of that workspace is deleted.
 *
 * WHEN: {@link PURGE_NOT_BEFORE}, the activity purge's own constant (imported, not copied). Every call to `purge()` deletes nothing
 * while its clock is before it, and says so (`held: true`). DAILY, not hourly.
 *
 * WHERE: a deployment WITHOUT plans (self-hosted, Stripe off) has no window and keeps everything: `purge()` returns `disabled`, and
 * the scheduler is not started.
 *
 * WHAT IS KEPT THOUGH OLD: the NEWEST `record_versions` row of each record and the NEWEST `document_versions` row of each document,
 * "newest" in the order the list uses, `(created_at, id)`. It is the restore baseline: the last captured state of a record that has
 * not been edited since. Readers checked (ticket #1386): nothing reads it once it is outside the window, because the list and restore
 * filter it out; it is kept on instruction, costs one row per record, and is the single line to drop (`keepNewest` below) if that
 * ruling changes. `record_field_changes` has no such row: a field change is an event, not a state.
 *
 * WHAT READS THE THREE TABLES (found, not guessed), so a deletion that looks safe is not: the History dialog (versions, preview,
 * restore, `changes`: all filtered by the window), `restoreMany` (the undo of a bulk edit: it restores a version made seconds ago),
 * the audit log (`kind: field_change` rows) and the agent activity read (`field_changes`). Those last two list a row for as long as
 * it exists, so after this purge their field changes end at the history window while their events end at the activity window: the
 * audit log's `retention_days` describes the events. My Work's "assigned by" reads `activity_events`, not these tables.
 *
 * HOW IT DELETES: batches, never one giant DELETE. Each batch picks its rows `FOR UPDATE SKIP LOCKED`, so two nodes (or two
 * overlapping calls) take disjoint rows: nothing is deleted twice, nothing waits, nothing deadlocks. There is no ORDER BY and no
 * pointer: none of the three tables has a `created_at`-led index, and a sort per batch would read the whole table every time
 * (the rows it leaves are the baseline rows only, so they are all a batch has to skip). Logs counts, never row data.
 */
export type HistoryTable = 'record_versions' | 'record_field_changes' | 'document_versions';
const TABLES: Array<{ table: HistoryTable; keepNewest: boolean }> = [
  { table: 'record_field_changes', keepNewest: false },
  { table: 'record_versions', keepNewest: true },
  { table: 'document_versions', keepNewest: true },
];
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After the activity purge's 60 s first run, so the two do not start together. */
const FIRST_RUN_DELAY_MS = 120 * 1000;
const PAUSE_BETWEEN_BATCHES_MS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export type VersionPurgeOptions = {
  /** The clock. Defaults to now; tests fix it. It is ALSO what the {@link PURGE_NOT_BEFORE} gate is judged by. */
  now?: Date;
  /** TEST SEAM for the gate: the instant before which nothing is deleted. Defaults to {@link PURGE_NOT_BEFORE}; nothing in `src` passes it. */
  notBefore?: Date;
  /** TEST SEAM: force the per-plan path on (true) or off (false); by default a hosted deployment (Stripe on) is per plan. */
  perPlan?: boolean;
  batchSize?: number;
  maxBatches?: number;
  pauseMs?: number;
};
/** `disabled`: there are no plans to apply. `held`: the clock is before {@link PURGE_NOT_BEFORE}. */
export type VersionPurgeResult = {
  deleted: number;
  byTable: Record<HistoryTable, number>;
  batches: number;
  capped: boolean;
  disabled: boolean;
  held: boolean;
};
const none = (): Record<HistoryTable, number> => ({ record_versions: 0, record_field_changes: 0, document_versions: 0 });

@Injectable()
export class VersionHistoryRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VersionHistoryRetentionService.name);
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    if (!this.entitlements.hostedPlans) {
      this.logger.log('version history purge is off: this deployment has no plans, so nothing is purged');
      return;
    }
    // Per node and per overlapping tick: skip a tick while the previous one is still walking. The purge itself is safe to run twice at
    // once (SKIP LOCKED); this only avoids a node competing with itself.
    const run = () => {
      if (this.running) return;
      this.running = true;
      void this.purge()
        .catch((error) => this.logger.warn(`version history purge failed: ${String(error)}`))
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

  /** The window each row is judged by, as a SQL timestamp expression, and the newest cutoff in play. Every plan has a branch; none is forever. */
  private cutoffs(now: Date): { expr: SQL; newest: string } {
    const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    const plans = (Object.keys(PLANS) as PlanId[]).filter((p) => Number.isFinite(PLANS[p].historyRetentionDays));
    const whens = plans.map((plan) => sql`WHEN ${plan} THEN ${at(PLANS[plan].historyRetentionDays)}::timestamptz`);
    return {
      // No ELSE: a plan this map does not know yields NULL, `created_at < NULL` is never true, nothing of that workspace is deleted.
      expr: sql`(CASE COALESCE(bs.plan::text, 'free') ${sql.join(whens, sql` `)} END)`,
      newest: at(Math.min(...plans.map((p) => PLANS[p].historyRetentionDays))),
    };
  }

  /** Delete expired history rows in batches. Returns counts only. Safe to call concurrently and repeatedly. */
  async purge(opts: VersionPurgeOptions = {}): Promise<VersionPurgeResult> {
    const now = opts.now ?? new Date();
    const notBefore = opts.notBefore ?? PURGE_NOT_BEFORE;
    if (now.getTime() < notBefore.getTime()) {
      this.logger.log(`version history purge held: nothing is deleted before ${notBefore.toISOString()}`);
      return { deleted: 0, byTable: none(), batches: 0, capped: false, disabled: false, held: true };
    }
    const perPlan = opts.perPlan ?? this.entitlements.hostedPlans;
    if (!perPlan) return { deleted: 0, byTable: none(), batches: 0, capped: false, disabled: true, held: false };

    const cutoffs = this.cutoffs(now);
    const batchSize = Math.max(1, opts.batchSize ?? PURGE_BATCH_SIZE);
    const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_RUN;
    const pauseMs = opts.pauseMs ?? PAUSE_BETWEEN_BATCHES_MS;

    const byTable = none();
    let batches = 0;
    let capped = false;
    for (const { table, keepNewest } of TABLES) {
      const t = sql.identifier(table);
      for (;;) {
        if (batches >= maxBatches) {
          capped = true;
          break;
        }
        const res = (await this.db.execute(sql`
          WITH picked AS MATERIALIZED (
            SELECT h.id
            FROM ${t} h
            LEFT JOIN billing_subscriptions bs ON bs.workspace_id = h.workspace_id
            WHERE h.created_at < ${cutoffs.newest}::timestamptz
              AND h.created_at < ${cutoffs.expr}
              ${keepNewest
                ? sql`AND EXISTS (SELECT 1 FROM ${t} n WHERE n.record_id = h.record_id AND (n.created_at, n.id) > (h.created_at, h.id))`
                : sql``}
            LIMIT ${batchSize}
            FOR UPDATE OF h SKIP LOCKED
          ), gone AS (
            DELETE FROM ${t} d USING picked p WHERE d.id = p.id RETURNING d.id
          )
          SELECT count(*)::int AS n FROM gone
        `)) as unknown as { rows: Array<{ n: number }> };
        const n = Number(res.rows[0]?.n ?? 0);
        if (n === 0) break;
        batches += 1;
        byTable[table] += n;
        if (n < batchSize) break;
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      if (capped) break;
    }
    const deleted = byTable.record_versions + byTable.record_field_changes + byTable.document_versions;
    if (deleted > 0 || capped) {
      this.logger.log(
        `version history purge: deleted ${deleted} rows in ${batches} batches (record_versions ${byTable.record_versions}, record_field_changes ${byTable.record_field_changes}, document_versions ${byTable.document_versions})${capped ? ` (stopped at ${maxBatches} batches; the next run continues)` : ''}`,
      );
    }
    return { deleted, byTable, batches, capped, disabled: false, held: false };
  }
}
