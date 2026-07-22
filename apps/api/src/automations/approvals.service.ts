import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, automations } from '../db/schema';
import { CommentsService } from '../comments/comments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobRunnerService } from './job-runner.service';
import type { ActionEffect } from './actions.service';

type ApprovalRow = typeof approvals.$inferSelect;

/** The FROZEN payload a gated action carries between "queued for approval"
 * and "approved" — `action` has every {Field}/{payload} token already
 * interpolated (actions.service.ts renders it before calling `create()`
 * below), and `ctx` is the same shape automation_jobs.payload.ctx already
 * uses so JobRunnerService's executors don't need a second code path. */
export interface ApprovalActionSnapshot {
  action: AutomationAction;
  ctx: { workspaceId: string; databaseId: string; recordId: string | null; actorId: string };
}

export interface CreateApprovalInput {
  workspaceId: string;
  databaseId: string;
  ruleId: string | null;
  runId: string | null;
  recordId: string | null;
  actionIndex: number;
  /** Already rendered — see ApprovalActionSnapshot's doc. */
  action: AutomationAction;
  previewText: string;
  /** The rule's run actor (or the button-presser, when there's no rule) —
   * used as the approver only when no rule (and hence no owner) exists. */
  requesterActorId: string;
}

function toDto(row: ApprovalRow) {
  return {
    id: row.id,
    rule_id: row.ruleId,
    run_id: row.runId,
    record_id: row.recordId,
    action_index: row.actionIndex,
    action_snapshot: row.actionSnapshot,
    preview_text: row.previewText,
    status: row.status,
    approver_id: row.approverId,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    reason: row.reason,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}

/**
 * MN-255 — the approval gate's own engine. `actions.service.ts`'s `execute()`
 * calls `create()` instead of running a `require_approval` action; the Inbox
 * (REST) and MCP's `list_approvals` read through `list()`/`get()`; a human
 * decides via `approve()`/`reject()`. The 7-day expiry sweep piggybacks
 * `AutomationsService.tick()` via `expireStale()` rather than owning its own
 * timer, the same way `JobRunnerService`'s reaper piggybacks its own tick.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly comments: CommentsService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobRunnerService,
  ) {}

  /** Rule owner by default, `automations.approver_id` as a per-rule override
   * (Step 2) — falls back to the requesting actor when there's no rule at
   * all (a one-off button press has no "rule owner" to default to). */
  private async approverFor(ruleId: string | null, fallbackActorId: string): Promise<string> {
    if (ruleId) {
      const rule = await this.db.query.automations.findFirst({ where: eq(automations.id, ruleId) });
      if (rule?.approverId) return rule.approverId;
      if (rule?.createdBy) return rule.createdBy;
    }
    return fallbackActorId;
  }

  /** Called from actions.service.ts's execute() in place of running a
   * `require_approval` action. Never throws on the notify half — a
   * notification failure must not stop the approval from existing. */
  async create(input: CreateApprovalInput): Promise<ActionEffect> {
    const approverId = await this.approverFor(input.ruleId, input.requesterActorId);
    const snapshot: ApprovalActionSnapshot = {
      action: input.action,
      ctx: {
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: input.recordId,
        actorId: input.requesterActorId,
      },
    };
    const [created] = await this.db
      .insert(approvals)
      .values({
        workspaceId: input.workspaceId,
        ruleId: input.ruleId,
        runId: input.runId,
        recordId: input.recordId,
        actionIndex: input.actionIndex,
        actionSnapshot: snapshot,
        previewText: input.previewText,
        approverId,
      })
      .returning();

    await this.notifications
      .notify({
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: input.recordId ?? undefined,
        actorId: input.requesterActorId,
        type: 'action_approval_requested',
        recipients: [approverId],
        snippet: input.previewText.slice(0, 140),
        refId: created!.id,
        // The rule owner must be asked even when they're the one whose rule
        // fired it — same reasoning as #210's agent-run gate.
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`approval notify failed: ${String(error)}`));

    return {
      type: 'pending_approval',
      record_id: input.recordId ?? undefined,
      summary: `Waiting for approval (approval ${created!.id}): ${input.previewText}`,
    };
  }

  async list(workspaceId: string, status?: string) {
    const rows = await this.db.query.approvals.findMany({
      where: and(eq(approvals.workspaceId, workspaceId), status ? eq(approvals.status, status) : undefined),
      orderBy: [desc(approvals.createdAt)],
      limit: 100,
    });
    return rows.map(toDto);
  }

  async get(workspaceId: string, id: string) {
    const row = await this.db.query.approvals.findFirst({
      where: and(eq(approvals.id, id), eq(approvals.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Approval not found');
    return row;
  }

  async approve(workspaceId: string, id: string, actorId: string) {
    return toDto(await this.resolve(workspaceId, id, actorId, 'approved'));
  }

  async reject(workspaceId: string, id: string, actorId: string, reason?: string) {
    return toDto(await this.resolve(workspaceId, id, actorId, 'rejected', reason));
  }

  /**
   * The shared half of approve/reject (mirrors agents.service.ts's own
   * resolveGate — same idea, different table). The transition is a single
   * `UPDATE … WHERE status = 'pending' RETURNING *`: under a concurrent
   * double-approve, only the request that actually flips the row gets a
   * non-empty `updated` back, so only ONE caller ever reaches the `enqueue()`
   * below — the job's own `idempotencyKey` uniqueness is defense in depth,
   * not what makes this idempotent.
   */
  private async resolve(
    workspaceId: string,
    id: string,
    actorId: string,
    verdict: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRow> {
    const approval = await this.get(workspaceId, id);
    if (approval.status !== 'pending') return approval; // already decided — idempotent no-op
    if (approval.expiresAt < new Date()) {
      await this.db
        .update(approvals)
        .set({ status: 'expired' })
        .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')));
      throw new UnprocessableEntityException('This approval expired before it was decided');
    }

    const [updated] = await this.db
      .update(approvals)
      .set({ status: verdict, decidedBy: actorId, decidedAt: new Date(), reason: reason ?? null })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .returning();
    if (!updated) {
      // Lost a race to a concurrent approve/reject/expire between the read
      // above and this write — the other caller's decision stands.
      return this.get(workspaceId, id);
    }

    if (verdict === 'approved') {
      const snapshot = updated.actionSnapshot as ApprovalActionSnapshot;
      await this.jobs.enqueue({
        workspaceId,
        ruleId: updated.ruleId,
        runId: updated.runId,
        actionIndex: updated.actionIndex,
        kind: snapshot.action.type,
        payload: { action: snapshot.action, ctx: snapshot.ctx },
        idempotencyKey: `approval:${updated.id}`,
        approvalId: updated.id,
      });
    }

    if (updated.recordId) {
      const text =
        verdict === 'approved'
          ? `Approved: ${updated.previewText}`
          : `Rejected: ${updated.previewText}${reason ? ` — ${reason}` : ''}`;
      await this.comments
        .create(workspaceId, updated.recordId, [{ type: 'text', text }], actorId)
        .catch((error: unknown) => this.logger.warn(`approval audit comment failed: ${String(error)}`));
    }
    return updated;
  }

  /**
   * Piggybacks AutomationsService.tick() (Step 3) rather than owning a
   * second timer. A pending approval nobody decided on within 7 days never
   * runs and never runs silently — the audit comment says so.
   */
  async expireStale(): Promise<void> {
    const expired = await this.db
      .update(approvals)
      .set({ status: 'expired' })
      .where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, new Date())))
      .returning();
    for (const approval of expired) {
      if (!approval.recordId) continue;
      await this.comments
        .create(
          approval.workspaceId,
          approval.recordId,
          [{ type: 'text', text: `Expired without a decision (7 days): ${approval.previewText}` }],
          approval.approverId ?? approval.ruleId ?? 'system',
        )
        .catch((error: unknown) => this.logger.warn(`expiry audit comment failed: ${String(error)}`));
    }
  }
}
