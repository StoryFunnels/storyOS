import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, automationJobs, automationRuns, automations, databases, records } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AccessService } from '../access/access.service';
import { DatabasesService } from '../databases/databases.service';
import { JobRunnerService } from '../automations/job-runner.service';

export interface RunsListFilters {
  kind?: 'rule' | 'source';
  status?: string;
  rule_id?: string;
  database_id?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

interface RunCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): RunCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Partial<RunCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

const KNOWN_STATUSES = new Set(['ok', 'error', 'skipped', 'skipped_quota', 'running']);

const SOURCE_KIND_NOTE =
  'kind=source has no data yet — the sources framework (MN-260/#239) has not landed. This filter is accepted so the API shape is forward-compatible; it will start returning source-sync runs once #239 ships.';

/**
 * MN-264 — the union-envelope read (+ rerun) surface over every automation
 * run in the workspace. NARROWED SCOPE: the ticket's own guide specs this as
 * a union of `automationRuns` (rule runs) and `source_runs` (source syncs,
 * MN-260/#239) — #239 is still "To Do" as of this ticket, so `source_runs`
 * does not exist in this schema version. Every row here is `kind: 'rule'`;
 * `kind: 'source'` is accepted as a filter (returns an empty page, not an
 * error) so the API shape is forward-compatible the day #239 lands, at which
 * point this service gains a second query branch and a real union, not a
 * contract change.
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly databasesService: DatabasesService,
    private readonly jobs: JobRunnerService,
  ) {}

  /**
   * Database ids this membership may see runs for. `null` = no filter (admin/
   * member see the whole workspace, same as ApprovalsController's read side).
   * A guest is narrowed to what AccessService already says they can see —
   * this is the one place in this service that differs from that precedent,
   * because unlike approvals (already point-scoped to one record a guest was
   * invited into), a workspace-wide run feed would otherwise leak rule names/
   * trigger activity from databases a guest has no grant on.
   */
  private async visibleDatabaseIds(membership: Membership): Promise<Set<string> | null> {
    if (membership.role !== 'guest') return null;
    const visibility = await this.access.guestVisibility(membership);
    if (!visibility) return null;
    const ids = new Set(visibility.databaseIds);
    if (visibility.spaceIds.size > 0) {
      const rows = await this.db.query.databases.findMany({
        where: inArray(databases.spaceId, [...visibility.spaceIds]),
        columns: { id: true },
      });
      rows.forEach((r) => ids.add(r.id));
    }
    return ids;
  }

  async list(workspaceId: string, membership: Membership, filters: RunsListFilters) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    // A source-only query has nothing to return yet — see module doc.
    if (filters.kind === 'source') {
      return { data: [], next_cursor: null, has_more: false, note: SOURCE_KIND_NOTE };
    }

    const visibleDbIds = await this.visibleDatabaseIds(membership);
    if (visibleDbIds && visibleDbIds.size === 0) {
      return { data: [], next_cursor: null, has_more: false };
    }

    const conditions = [eq(automationRuns.workspaceId, workspaceId)];
    if (filters.status) {
      if (!KNOWN_STATUSES.has(filters.status)) return { data: [], next_cursor: null, has_more: false };
      conditions.push(eq(automationRuns.status, filters.status));
    }
    if (filters.rule_id) conditions.push(eq(automationRuns.automationId, filters.rule_id));
    if (filters.database_id) {
      if (visibleDbIds && !visibleDbIds.has(filters.database_id)) {
        return { data: [], next_cursor: null, has_more: false };
      }
      conditions.push(eq(automations.databaseId, filters.database_id));
    } else if (visibleDbIds) {
      conditions.push(inArray(automations.databaseId, [...visibleDbIds]));
    }
    if (filters.from) conditions.push(gte(automationRuns.createdAt, new Date(filters.from)));
    if (filters.to) conditions.push(lte(automationRuns.createdAt, new Date(filters.to)));
    if (filters.q) conditions.push(sql`${records.title} ILIKE ${'%' + filters.q + '%'}`);

    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    if (cursor) {
      const created = new Date(cursor.createdAt);
      conditions.push(
        sql`(${automationRuns.createdAt}, ${automationRuns.id}) < (${created.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select({
        id: automationRuns.id,
        automationId: automationRuns.automationId,
        status: automationRuns.status,
        error: automationRuns.error,
        depth: automationRuns.depth,
        durationMs: automationRuns.durationMs,
        createdAt: automationRuns.createdAt,
        triggerRecordId: automationRuns.triggerRecordId,
        ruleName: automations.name,
        trigger: automations.trigger,
        databaseId: automations.databaseId,
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .leftJoin(records, eq(records.id, automationRuns.triggerRecordId))
      .where(and(...conditions))
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const recordIds = page.map((r) => r.triggerRecordId).filter((v): v is string => Boolean(v));
    const recordTitles = recordIds.length
      ? await this.db.query.records.findMany({
          where: inArray(records.id, recordIds),
          columns: { id: true, title: true, number: true },
        })
      : [];
    const recordById = new Map(recordTitles.map((r) => [r.id, r]));

    const runIds = page.map((r) => r.id);
    const jobRows = runIds.length
      ? await this.db.query.automationJobs.findMany({
          where: inArray(automationJobs.runId, runIds),
          columns: { runId: true, kind: true, status: true },
        })
      : [];
    const summaryByRun = new Map<string, { kind: string; status: string }[]>();
    for (const job of jobRows) {
      if (!job.runId) continue;
      const list = summaryByRun.get(job.runId) ?? [];
      list.push({ kind: job.kind, status: job.status });
      summaryByRun.set(job.runId, list);
    }

    return {
      data: page.map((r) => ({
        id: r.id,
        kind: 'rule' as const,
        name: r.ruleName,
        rule_id: r.automationId,
        database_id: r.databaseId,
        trigger_kind: (r.trigger as { type?: string } | null)?.type ?? null,
        record_ref: r.triggerRecordId
          ? {
              id: r.triggerRecordId,
              title: recordById.get(r.triggerRecordId)?.title ?? null,
              number: recordById.get(r.triggerRecordId)?.number ?? null,
            }
          : null,
        status: r.status,
        error: r.error,
        started_at: r.createdAt.toISOString(),
        duration_ms: r.durationMs,
        action_summary: summaryByRun.get(r.id) ?? [],
      })),
      next_cursor:
        hasMore && page.length > 0
          ? encodeCursor({
              createdAt: page[page.length - 1]!.createdAt.toISOString(),
              id: page[page.length - 1]!.id,
            })
          : null,
      has_more: hasMore,
    };
  }

  private async loadRun(workspaceId: string, runId: string) {
    const row = await this.db.query.automationRuns.findFirst({
      where: and(eq(automationRuns.id, runId), eq(automationRuns.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Run not found');
    const rule = await this.db.query.automations.findFirst({
      where: eq(automations.id, row.automationId),
    });
    return { row, rule };
  }

  async detail(workspaceId: string, membership: Membership, runId: string) {
    const { row, rule } = await this.loadRun(workspaceId, runId);
    if (rule) {
      const visibleDbIds = await this.visibleDatabaseIds(membership);
      if (visibleDbIds && !visibleDbIds.has(rule.databaseId)) {
        throw new NotFoundException('Run not found');
      }
    }

    const recordRef = row.triggerRecordId
      ? await this.db.query.records.findFirst({
          where: eq(records.id, row.triggerRecordId),
          columns: { id: true, title: true, number: true },
        })
      : null;

    const jobRows = await this.db.query.automationJobs.findMany({
      where: eq(automationJobs.runId, row.id),
      orderBy: [automationJobs.actionIndex],
    });
    const approvalRows = await this.db.query.approvals.findMany({
      where: eq(approvals.runId, row.id),
      orderBy: [approvals.actionIndex],
    });
    const approvalByIndex = new Map(approvalRows.map((a) => [a.actionIndex, a]));
    const seenIndexes = new Set(jobRows.map((j) => j.actionIndex));

    const jobActions = jobRows.map((j) => {
      const approval = approvalByIndex.get(j.actionIndex);
      return {
        action_index: j.actionIndex,
        kind: j.kind,
        status: j.status,
        attempts: j.attempts,
        last_error: j.lastError,
        artifact: j.artifact,
        connection_id: j.connectionId,
        idempotency_key: j.idempotencyKey,
        approval: approval
          ? {
              id: approval.id,
              status: approval.status,
              decided_by: approval.decidedBy,
              decided_at: approval.decidedAt,
              preview_text: approval.previewText,
            }
          : null,
      };
    });
    // Approvals with no job row yet (still pending — ApprovalsService.approve()
    // only enqueues the job once a human decides) show up as their own entry.
    const pendingApprovalActions = approvalRows
      .filter((a) => !seenIndexes.has(a.actionIndex))
      .map((a) => ({
        action_index: a.actionIndex,
        kind: null,
        status: a.status === 'pending' ? 'pending_approval' : a.status,
        attempts: 0,
        last_error: null,
        artifact: null,
        connection_id: null,
        idempotency_key: null,
        approval: {
          id: a.id,
          status: a.status,
          decided_by: a.decidedBy,
          decided_at: a.decidedAt,
          preview_text: a.previewText,
        },
      }));

    return {
      id: row.id,
      kind: 'rule' as const,
      name: rule?.name ?? null,
      rule_id: row.automationId,
      database_id: rule?.databaseId ?? null,
      trigger: rule?.trigger ?? null,
      condition: rule?.condition ?? null,
      record_ref: recordRef ? { id: recordRef.id, title: recordRef.title, number: recordRef.number } : null,
      status: row.status,
      error: row.error,
      depth: row.depth,
      started_at: row.createdAt.toISOString(),
      duration_ms: row.durationMs,
      effects: row.effects,
      actions: [...jobActions, ...pendingApprovalActions].sort((a, b) => a.action_index - b.action_index),
    };
  }

  /**
   * Re-run one failed action from a run with its ORIGINAL frozen payload —
   * enqueues a brand-new automation_jobs row (not a retry of the old one) so
   * the failed row's history stays intact, keyed off a NEW idempotency key
   * (the original `:rerun:${n}` suffixed, n = how many reruns already exist)
   * since this is explicit human intent, distinct from JobRunnerService's own
   * automatic backoff retries of the SAME row. Requires 'editor' on the
   * rule's database — the same rank automations.controller.ts's `creator`
   * gate implies for schema changes, one rung down: re-running an already-
   * queued action is closer to "delete records/views" (editor) than to
   * "edit the rule itself" (creator).
   */
  async rerun(workspaceId: string, membership: Membership, runId: string, actionIndex: number) {
    const { row, rule } = await this.loadRun(workspaceId, runId);
    if (!rule) throw new NotFoundException('The rule this run belonged to no longer exists');
    await this.databasesService.assertAccess(membership, rule.databaseId, 'editor');

    // Reruns share (runId, actionIndex) with the original job — order by
    // newest so a second rerun operates on the LATEST attempt, not always the
    // original (which would otherwise let a still-failing action look
    // re-runnable forever off a stale row instead of its own latest outcome).
    const job = await this.db.query.automationJobs.findFirst({
      where: and(eq(automationJobs.runId, row.id), eq(automationJobs.actionIndex, actionIndex)),
      orderBy: [desc(automationJobs.createdAt)],
    });
    if (!job) throw new NotFoundException('No queued action at this index for this run');
    if (job.status !== 'failed') {
      throw new ConflictException(
        job.status === 'succeeded'
          ? 'This action already succeeded — nothing to re-run.'
          : `This action is currently "${job.status}" — only a failed action can be re-run.`,
      );
    }

    // Strip a trailing ":rerun:N" so re-running an already-rerun job counts
    // against the ORIGINAL base key, not the latest attempt's own key —
    // otherwise a second rerun's LIKE search would never find the first.
    const baseIdempotencyKey = job.idempotencyKey.replace(/:rerun:\d+$/, '');
    const priorReruns = await this.db.query.automationJobs.findMany({
      where: sql`${automationJobs.idempotencyKey} LIKE ${baseIdempotencyKey + ':rerun:%'}`,
      columns: { id: true },
    });
    const idempotencyKey = `${baseIdempotencyKey}:rerun:${priorReruns.length + 1}`;

    const enqueued = await this.jobs.enqueue({
      workspaceId,
      ruleId: job.ruleId,
      runId: job.runId,
      connectionId: job.connectionId,
      actionIndex: job.actionIndex,
      kind: job.kind,
      payload: job.payload as Record<string, unknown>,
      idempotencyKey,
      timeoutClass: job.timeoutClass as 'short' | 'long' | 'upload',
    });
    return { job_id: enqueued.jobId, status: enqueued.status, idempotency_key: idempotencyKey };
  }
}
