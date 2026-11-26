import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { MAX_ATTEMPTS } from '../common/backoff-schedule';
import { approvals, automationJobs, connections } from '../db/schema';
import { looksLikeUuid } from '../common/uuid';
import { RecordsService } from '../records/records.service';
import { JobRunnerService } from './job-runner.service';
import { channelOfTarget, isSocialTarget, namesAccount, SOCIAL_TARGETS, targetEnabled } from './social-targets';
import type { SocialChannel, SocialTarget } from './social-targets';
import type { PostSocialAction } from './post-social.action';
import { parseFailure } from './publish-failure';
import type { PublishFailure } from './publish-failure';

export { parseFailure };
export type { PublishFailure };

type ApprovalRow = typeof approvals.$inferSelect;
type AutomationJobRow = typeof automationJobs.$inferSelect;

/** How many post_social jobs / approvals of one record are looked at. A record is published a handful of times. */
const SCAN_LIMIT = 200;
/** Retrying is a person's decision, not a loop: this many manual retries per original publish, then 409. */
export const MAX_MANUAL_RETRIES = 5;
const RETRY_MARK = ':retry-of:';

export type PublishState = 'awaiting_approval' | 'sent_back' | 'expired' | 'queued' | 'running' | 'published' | 'failed';


/** What one channel of one record did, as the record shows it. Everything here is safe to show to anyone who can read the record. */
export interface SocialPublish {
  /** The network: a LinkedIn profile and a LinkedIn page are both `linkedin`; `target` tells them apart. */
  channel: SocialChannel;
  target: SocialTarget;
  account: { connection_id: string | null; connection_name: string | null; account_id: string | null };
  state: PublishState;
  /** The job id: what `retry` is addressed by. Null while the post is only waiting for approval. */
  publish_id: string | null;
  approval: { id: string; status: string; approver_id: string | null; decided_by: string | null; decided_at: string | null; reason: string | null } | null;
  attempt: number;
  max_attempts: number;
  /** Set only while an automatic retry is scheduled. */
  next_attempt_at: string | null;
  will_retry: boolean;
  error: PublishFailure | null;
  post_url: string | null;
  /** Ticket #60 — bytes of a video already sent while an upload is open (running, or waiting to resume), else null. Never a session address. */
  progress: { sent_bytes: number; total_bytes: number } | null;
  external_id: string | null;
  rule_id: string | null;
  run_id: string | null;
  action_index: number;
  created_at: string;
  updated_at: string;
  /** True when THIS caller could press "Try again" right now: failed, nothing posted, within the retry cap, and they can edit the record. */
  can_retry: boolean;
}

interface Snapshot {
  action?: Partial<PostSocialAction> & { type?: string };
  ctx?: { databaseId?: string; recordId?: string | null };
  upload?: { bytes_sent?: unknown; size?: unknown };
}

/** The upload's progress from the job payload: only the two counts, only when they are sane numbers. */
function uploadProgress(upload: Snapshot['upload']): SocialPublish['progress'] {
  const sent = upload?.bytes_sent;
  const total = upload?.size;
  if (typeof sent !== 'number' || typeof total !== 'number' || !Number.isFinite(sent) || !Number.isFinite(total) || total <= 0 || sent < 0 || sent > total) return null;
  return { sent_bytes: sent, total_bytes: total };
}


/**
 * Ticket #42 — the per-record publish state, and the retry. No table of its own: a publish attempt IS an
 * `automation_jobs` row (status, attempts, next_attempt_at, last_error, artifact) and, while it waits, an `approvals`
 * row. This reads them back by record, one entry per channel (rule + action + target), latest outcome.
 */
@Injectable()
export class SocialPublishesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRunnerService,
    private readonly records: RecordsService,
  ) {}

  private recordJobs(workspaceId: string, databaseId: string, recordId: string) {
    return this.db
      .select()
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.workspaceId, workspaceId),
          eq(automationJobs.kind, 'post_social'),
          // The payload's frozen ctx is the only record link a job has. Both ids are matched, so an id from another database never lines up.
          sql`${automationJobs.payload} #>> '{ctx,recordId}' = ${recordId}`,
          sql`${automationJobs.payload} #>> '{ctx,databaseId}' = ${databaseId}`,
        ),
      )
      .orderBy(desc(automationJobs.createdAt))
      .limit(SCAN_LIMIT);
  }

  async list(workspaceId: string, databaseId: string, recordId: string, canEdit: boolean): Promise<{ data: SocialPublish[] }> {
    const jobRows = await this.recordJobs(workspaceId, databaseId, recordId);
    const approvalRows = await this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.recordId, recordId),
          sql`${approvals.actionSnapshot} #>> '{action,type}' = 'post_social'`,
          sql`${approvals.actionSnapshot} #>> '{ctx,databaseId}' = ${databaseId}`,
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(SCAN_LIMIT);

    const approvalById = new Map(approvalRows.map((a) => [a.id, a]));
    const connectionIds = [...new Set(jobRows.map((j) => j.connectionId).filter((v): v is string => !!v))];
    const approvalConnectionIds = approvalRows
      .map((a) => (a.actionSnapshot as Snapshot).action?.connection_id)
      .filter((v): v is string => typeof v === 'string');
    const allConnectionIds = [...new Set([...connectionIds, ...approvalConnectionIds])];
    const names = new Map<string, string>();
    if (allConnectionIds.length) {
      const rows = await this.db
        .select({ id: connections.id, name: connections.name })
        .from(connections)
        .where(and(eq(connections.workspaceId, workspaceId), inArray(connections.id, allConnectionIds)));
      for (const r of rows) names.set(r.id, r.name);
    }

    const resultFilled = canEdit ? await this.resultFieldsFilled(databaseId, recordId, jobRows) : new Set<string>();
    const retryCounts = canEdit ? this.retryCounts(jobRows) : new Map<string, number>();

    type Candidate = { at: number; key: string; view: SocialPublish };
    const candidates: Candidate[] = [];

    for (const job of jobRows) {
      if (job.status === 'canceled') continue;
      const action = (job.payload as Snapshot).action ?? {};
      const target = (action.target ?? 'x') as SocialPublish['target'];
      const approval = job.approvalId ? approvalById.get(job.approvalId) ?? (await this.loadApproval(job.approvalId)) : null;
      const failure = parseFailure(job.lastError);
      const state: PublishState = job.status === 'succeeded' ? 'published' : job.status === 'failed' ? 'failed' : job.status === 'running' ? 'running' : 'queued';
      const artifact = (job.artifact ?? {}) as { url?: unknown; external_id?: unknown };
      const retryingByItself = state === 'queued' && job.attempts > 0;
      const base = job.idempotencyKey.split(RETRY_MARK)[0]!;
      const filled = action.result_field_id ? resultFilled.has(`${action.result_field_id}`) : false;
      candidates.push({
        at: job.createdAt.getTime(),
        key: `${job.ruleId ?? 'none'}:${job.actionIndex}:${target}`,
        view: {
          channel: channelOfTarget(target),
          target,
          account: {
            connection_id: job.connectionId,
            connection_name: job.connectionId ? names.get(job.connectionId) ?? null : null,
            account_id: typeof action.account_id === 'string' ? action.account_id : null,
          },
          state,
          publish_id: job.id,
          approval: approval ? this.approvalView(approval) : null,
          attempt: job.attempts,
          max_attempts: MAX_ATTEMPTS,
          next_attempt_at: retryingByItself ? job.nextAttemptAt.toISOString() : null,
          will_retry: retryingByItself,
          error: state === 'published' ? null : failure,
          post_url: state === 'published' && typeof artifact.url === 'string' ? artifact.url : null,
          progress: state === 'running' || state === 'queued' ? uploadProgress((job.payload as Snapshot).upload) : null,
          external_id: state === 'published' && typeof artifact.external_id === 'string' ? artifact.external_id : null,
          rule_id: job.ruleId,
          run_id: job.runId,
          action_index: job.actionIndex,
          created_at: job.createdAt.toISOString(),
          updated_at: job.updatedAt.toISOString(),
          can_retry:
            canEdit &&
            state === 'failed' &&
            !!job.connectionId &&
            !filled &&
            (retryCounts.get(base) ?? 0) < MAX_MANUAL_RETRIES &&
            namesAccount(action),
        },
      });
    }

    for (const approval of approvalRows) {
      // An approved approval is represented by the job it enqueued, never twice.
      if (approval.status === 'approved') continue;
      const snap = approval.actionSnapshot as Snapshot;
      const action = snap.action ?? {};
      const target = (action.target ?? 'x') as SocialPublish['target'];
      const state: PublishState = approval.status === 'pending' ? 'awaiting_approval' : approval.status === 'rejected' ? 'sent_back' : 'expired';
      candidates.push({
        at: approval.createdAt.getTime(),
        key: `${approval.ruleId ?? 'none'}:${approval.actionIndex}:${target}`,
        view: {
          channel: channelOfTarget(target),
          target,
          account: {
            connection_id: action.connection_id ?? null,
            connection_name: action.connection_id ? names.get(action.connection_id) ?? null : null,
            account_id: typeof action.account_id === 'string' ? action.account_id : null,
          },
          state,
          publish_id: null,
          approval: this.approvalView(approval),
          attempt: 0,
          max_attempts: MAX_ATTEMPTS,
          next_attempt_at: null,
          will_retry: false,
          error: null,
          post_url: null,
          progress: null,
          external_id: null,
          rule_id: approval.ruleId,
          run_id: approval.runId,
          action_index: approval.actionIndex,
          created_at: approval.createdAt.toISOString(),
          updated_at: approval.updatedAt.toISOString(),
          can_retry: false,
        },
      });
    }

    // One entry per channel: its latest thing. A later approval or retry replaces an older outcome, never merges with it.
    const latest = new Map<string, Candidate>();
    for (const c of candidates) {
      const seen = latest.get(c.key);
      if (!seen || c.at > seen.at) latest.set(c.key, c);
    }
    return { data: [...latest.values()].sort((a, b) => b.at - a.at).map((c) => c.view) };
  }

  private approvalView(a: ApprovalRow): NonNullable<SocialPublish['approval']> {
    return {
      id: a.id,
      status: a.status,
      approver_id: a.approverId,
      decided_by: a.decidedBy,
      decided_at: a.decidedAt ? a.decidedAt.toISOString() : null,
      reason: a.reason,
    };
  }

  private async loadApproval(id: string): Promise<ApprovalRow | null> {
    const row = await this.db.query.approvals.findFirst({ where: eq(approvals.id, id) });
    return row ?? null;
  }

  /** The result-field ids (as strings) that already hold a value on this record: a post that is already linked must not be retried. */
  private async resultFieldsFilled(databaseId: string, recordId: string, jobRows: AutomationJobRow[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const j of jobRows) {
      const id = (j.payload as Snapshot).action?.result_field_id;
      if (typeof id === 'string') ids.add(id);
    }
    const filled = new Set<string>();
    if (!ids.size) return filled;
    const row = await this.records.getRow(databaseId, recordId);
    const values = (row.values ?? {}) as Record<string, unknown>;
    for (const id of ids) {
      const v = values[id];
      if (typeof v === 'string' && v.trim().length > 0) filled.add(id);
    }
    return filled;
  }

  private retryCounts(jobRows: AutomationJobRow[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const j of jobRows) {
      if (!j.idempotencyKey.includes(RETRY_MARK)) continue;
      const base = j.idempotencyKey.split(RETRY_MARK)[0]!;
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Re-queue ONE failed publish with its ORIGINAL frozen payload: same connection, same named account, same approved text.
   * It never re-picks an account (that would send approved content somewhere the approver did not approve) and never asks
   * for a second approval (nothing about what was approved changed). Idempotent by construction: the new job's key is
   * derived from the failed job's id, so pressing it twice yields the same one job, and a post that already went out is a 409.
   */
  async retry(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    publishId: string,
  ): Promise<{ publish_id: string; state: PublishState; retry_of: string }> {
    // A non-uuid id would reach the driver as a cast error (a 500); it is simply no such publish.
    if (!looksLikeUuid(publishId)) throw new NotFoundException('Publish not found');
    const job =await this.db.query.automationJobs.findFirst({
      where: and(
        eq(automationJobs.id, publishId),
        eq(automationJobs.workspaceId, workspaceId),
        eq(automationJobs.kind, 'post_social'),
        sql`${automationJobs.payload} #>> '{ctx,recordId}' = ${recordId}`,
        sql`${automationJobs.payload} #>> '{ctx,databaseId}' = ${databaseId}`,
      ),
    });
    if (!job) throw new NotFoundException('Publish not found');

    if (job.status === 'succeeded') throw new ConflictException('This post already went out. Nothing was posted again.');
    if (job.status !== 'failed') throw new ConflictException(`This post is ${job.status === 'running' ? 'being sent right now' : 'still queued'}. Only a failed post can be retried.`);

    const base = job.idempotencyKey.split(RETRY_MARK)[0]!;
    const childKey = `${base}${RETRY_MARK}${job.id}`;
    const child = await this.db.query.automationJobs.findFirst({ where: eq(automationJobs.idempotencyKey, childKey) });
    if (child) {
      if (child.status === 'queued' || child.status === 'running') return { publish_id: child.id, state: child.status as PublishState, retry_of: job.id };
      throw new ConflictException('A newer attempt of this post exists. Retry that one.');
    }

    const action = (job.payload as Snapshot).action as Partial<PostSocialAction>;
    // A newer job on the same channel supersedes this one (the rule fired again, or another retry exists).
    const channelJobs = (await this.recordJobs(workspaceId, databaseId, recordId)).filter(
      (j) => j.ruleId === job.ruleId && j.actionIndex === job.actionIndex && (j.payload as Snapshot).action?.target === action.target,
    );
    if (channelJobs.some((j) => j.id !== job.id && j.createdAt.getTime() > job.createdAt.getTime() && j.status !== 'canceled')) {
      throw new ConflictException('A newer attempt of this post exists. Retry that one.');
    }

    // Dedup: a post whose link is already on the record is posted; the executor would refuse it anyway, so say so here.
    if (action.result_field_id) {
      const row = await this.records.getRow(databaseId, recordId);
      const v = ((row.values ?? {}) as Record<string, unknown>)[action.result_field_id];
      if (typeof v === 'string' && v.trim().length > 0) throw new ConflictException('This post already has a link on the record, so it was posted. Nothing was posted again.');
    }

    // Nothing posts from an unnamed account, and the connection must still be one of this workspace's.
    if (!namesAccount(action)) {
      throw new UnprocessableEntityException('This post does not name the account it goes out as. Pick the account in the rule and run it again.');
    }
    if (!job.connectionId) throw new NotFoundException('The connection this post used no longer exists. Reconnect it and run the rule again.');
    const connection = await this.db.query.connections.findFirst({
      where: and(eq(connections.id, job.connectionId), eq(connections.workspaceId, workspaceId)),
      columns: { id: true, provider: true },
    });
    if (!connection) throw new NotFoundException('The connection this post used no longer exists. Reconnect it and run the rule again.');
    if (!isSocialTarget(action.target)) throw new UnprocessableEntityException('This post has no known network to go out on.');
    if (!targetEnabled(action.target)) {
      throw new UnprocessableEntityException(SOCIAL_TARGETS[action.target].gateMessage);
    }

    const prior = await this.db
      .select({ id: automationJobs.id })
      .from(automationJobs)
      .where(and(eq(automationJobs.workspaceId, workspaceId), like(automationJobs.idempotencyKey, `${base}${RETRY_MARK}%`)));
    if (prior.length >= MAX_MANUAL_RETRIES) {
      throw new ConflictException(`This post was retried ${MAX_MANUAL_RETRIES} times already. Fix the cause in the rule, then run it again.`);
    }

    const enqueued = await this.jobs.enqueue({
      workspaceId,
      ruleId: job.ruleId,
      runId: job.runId,
      connectionId: job.connectionId,
      // The approval the post already had stays attached, so the outcome of this attempt is reported on the record the same way.
      approvalId: job.approvalId,
      actionIndex: job.actionIndex,
      kind: job.kind,
      payload: job.payload as Record<string, unknown>,
      idempotencyKey: childKey,
      timeoutClass: job.timeoutClass as 'short' | 'long' | 'upload',
    });
    return { publish_id: enqueued.jobId, state: 'queued', retry_of: job.id };
  }
}
