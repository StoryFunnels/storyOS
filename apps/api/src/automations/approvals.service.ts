import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, automations, databases, sourceRuns, tyronMessages } from '../db/schema';
import { CommentsService } from '../comments/comments.service';
import { NotificationsService, type NotificationType } from '../notifications/notifications.service';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { AgentPrincipal } from '../agents/agent-principal';
import type { AgentStep, ProposedAction } from '../agents/agent-runtime';
import { JobRunnerService } from './job-runner.service';
import type { ActionEffect } from './actions.service';

type ApprovalRow = typeof approvals.$inferSelect;

/**
 * #282 — a held write-back push (write-back.subscriber.ts). Deliberately NOT
 * a member of `actionSchema`'s discriminated union in @storyos/schemas: that
 * union is what the automation rule-builder renders pickers from, and this
 * is never a step a human authors — it is constructed server-side only, by
 * WriteBackSubscriber, and never parsed from client input. Widening
 * `ApprovalActionSnapshot`/`CreateApprovalInput` below to accept this
 * alongside `AutomationAction` reuses the SAME table/approve/reject/expire
 * machinery (the whole point of this ticket) without exposing a system
 * action as a user-authorable one.
 */
export interface WriteBackPushAction {
  type: 'write_back_push';
  source_id: string;
  external_key: string;
  values: Record<string, unknown>;
}

/**
 * #603 — an agent run's staged action (ADR-0010 §4), the third producer this
 * table now carries. `run_id` doubles as the row's own `runId` column value
 * (agents.service.ts's convention: one outstanding gate per run, looked up by
 * `findByRunId`) — kept here too since `action_snapshot` is what a reader
 * actually inspects to know what kind of gate this is and what it needs to
 * re-apply. `runs_db_id` is carried because applying/canceling the gate means
 * writing back to the run RECORD, and that write needs the database id
 * `RecordsService.update` takes — the run's own `ctx.databaseId` (below)
 * already IS this same id, so it's redundant on the wire but named here for
 * clarity at the two read sites (resolveGate, applyProposedAction).
 *
 * Only TYPES are imported from `agents/` (erased at compile time) — this
 * file adds no runtime dependency on AgentsModule. The actual "how do I
 * apply this" logic stays in AgentsService, which already depends on
 * ApprovalsService one-way (AgentsModule imports AutomationsModule); this
 * table only needs to know the SHAPE of what it's storing.
 */
export interface AgentProposedActionSnapshot {
  type: 'agent_proposed_action';
  runs_db_id: string;
  run_id: string;
  proposed: ProposedAction;
  steps: AgentStep[];
  principal?: AgentPrincipal;
  usage?: { tokensIn: number; tokensOut: number };
}

/**
 * #542 — a Tyron-classified `approval_gate` tool call (write-safety.ts), the
 * fourth producer. Unlike the other three, there is no database this call is
 * naturally scoped to — Tyron's outward tools (`share_view`, `sync_source`,
 * `update_webhook`, …) are workspace-level, not per-database — so `ctx.
 * databaseId` below is stamped with the WORKSPACE id as a deliberate
 * placeholder (documented at that call site), not a real database. It never
 * matches a real database uuid, so a restricted guest's `list()` scoping
 * (which only ever WIDENS visibility for a matching id) fails closed rather
 * than open; the only path that resolves one of these today already
 * requires the approver to be an admin (see resolveApprovalGate below), so
 * this is belt-and-braces, not the actual access boundary.
 *
 * `member_user_id` is who to re-mint a token FOR when applying (attribution
 * stays the member who asked Tyron, per ADR-0016 §1 — never the approving
 * admin, who is authorizing, not acting).
 */
export interface TyronToolCallSnapshot {
  type: 'tyron_tool_call';
  thread_id: string;
  member_user_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** The confirmation text Tyron already showed in the thread — reused
   *  verbatim so the approver reads the exact same sentence the member did. */
  message: string;
}

/** The FROZEN payload a gated action carries between "queued for approval"
 * and "approved" — `action` has every {Field}/{payload} token already
 * interpolated (actions.service.ts renders it before calling `create()`
 * below), and `ctx` is the same shape automation_jobs.payload.ctx already
 * uses so JobRunnerService's executors don't need a second code path. */
export interface ApprovalActionSnapshot {
  action: AutomationAction | WriteBackPushAction | AgentProposedActionSnapshot | TyronToolCallSnapshot;
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
  action: AutomationAction | WriteBackPushAction | AgentProposedActionSnapshot | TyronToolCallSnapshot;
  previewText: string;
  /** The rule's run actor (or the button-presser, when there's no rule) —
   * used as the approver only when no rule (and hence no owner) exists. */
  requesterActorId: string;
  /**
   * #603 — an agent run's gate wants the SAME notification the direct
   * `agents.service.ts` staging code always sent (`approval_requested`, a
   * summary naming the agent and the action), not the automation-shaped
   * `action_approval_requested`/previewText default below. Omitted by every
   * existing (automation) caller, so their behavior is unchanged byte-for-
   * byte — this is additive, not a new default.
   */
  notification?: { type: NotificationType; snippet: string };
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
    private readonly access: AccessService,
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

  /**
   * #603 — the shared insert+notify core, extracted so a non-automation
   * producer (agents.service.ts) can get the real row back (it needs the id
   * for nothing today — lookup is by `run_id`, see `findByRunId` — but the
   * full row is the more honest return type than `create()`'s automation-
   * shaped `ActionEffect`). `create()` below is now a thin wrapper kept for
   * `actions.service.ts`'s existing call site — behavior unchanged.
   */
  async createRow(input: CreateApprovalInput): Promise<ApprovalRow> {
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
        type: input.notification?.type ?? 'action_approval_requested',
        recipients: [approverId],
        snippet: input.notification?.snippet ?? input.previewText.slice(0, 140),
        refId: created!.id,
        // The rule owner must be asked even when they're the one whose rule
        // fired it — same reasoning as #210's agent-run gate.
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`approval notify failed: ${String(error)}`));

    return created!;
  }

  /** Called from actions.service.ts's execute() in place of running a
   * `require_approval` action. Never throws on the notify half — a
   * notification failure must not stop the approval from existing. */
  async create(input: CreateApprovalInput): Promise<ActionEffect> {
    const created = await this.createRow(input);
    return {
      type: 'pending_approval',
      record_id: input.recordId ?? undefined,
      summary: `Waiting for approval (approval ${created.id}): ${input.previewText}`,
    };
  }

  /** #603 — the run-keyed lookup agents.service.ts's controller-facing
   * approve/reject uses: one outstanding gate per run, by construction (a
   * run halts at its first gated step and stays parked until decided), so
   * "most recent pending row for this run" is unambiguous. Generic on
   * `runId` rather than agent-specific — reusable by anything else keyed by
   * a run the way `approvals.run_id`'s own no-FK design already intends. */
  async findByRunId(workspaceId: string, runId: string): Promise<ApprovalRow | null> {
    const row = await this.db.query.approvals.findFirst({
      where: and(eq(approvals.workspaceId, workspaceId), eq(approvals.runId, runId)),
      orderBy: [desc(approvals.createdAt)],
    });
    return row ?? null;
  }

  /**
   * #654 — this was workspace-wide with no per-database check at all, so a
   * guest holding a grant on exactly one database could list every OTHER
   * database's pending/decided approvals, including `action_snapshot` (can
   * carry triggering-record field values). `ctx.databaseId` is always
   * present on every row's own frozen snapshot (`create()` above), so
   * filtering needs no join — `visibleDatabaseIds` returns `null` for an
   * admin/member (unrestricted, matches today's behavior exactly), or the
   * guest's actual visible set.
   */
  async list(membership: Membership, status?: string) {
    const rows = await this.db.query.approvals.findMany({
      where: and(
        eq(approvals.workspaceId, membership.workspaceId),
        status ? eq(approvals.status, status) : undefined,
      ),
      orderBy: [desc(approvals.createdAt)],
      limit: 100,
    });
    const visible = await this.access.visibleDatabaseIds(membership);
    const scoped = visible === null ? rows : rows.filter((r) => visible.has((r.actionSnapshot as ApprovalActionSnapshot).ctx.databaseId));
    return scoped.map(toDto);
  }

  async get(workspaceId: string, id: string) {
    const row = await this.db.query.approvals.findFirst({
      where: and(eq(approvals.id, id), eq(approvals.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Approval not found');
    return row;
  }

  /**
   * #691 — `list()` was already scoped by #654; `get()` above is the one
   * caller #654 didn't reach, because it isn't a route by itself — only
   * `ApprovalsController.assertHuman` (approve/reject) calls it, and only
   * to decide 403-vs-allow. That still mattered on its own: a non-admin,
   * non-approver member hitting approve/reject on an approval in a
   * database they can't see got a 403 ("you can't decide this") rather
   * than a 404 ("nothing here") — an existence oracle over `ctx.databaseId`
   * distinguishable from the ordinary wrong-id 404, same class of leak
   * #654 closed for `list()`.
   *
   * Deliberately NOT folded into `get()` itself as a blanket gate: the
   * named `approverId` is its own, more specific authorization, and can
   * legitimately be a guest with a record-scoped (not database-level)
   * grant, or no general grant on `ctx.databaseId` at all. Gating `get()`
   * on database visibility would 404 that guest out of approving their
   * OWN assigned approval. The controller checks `isApprover` FIRST and
   * only asks this when that's already failed — this decides what the
   * REJECTION should look like, never whether an authorized approver may
   * proceed.
   */
  async visibleToMembership(membership: Membership, row: ApprovalRow): Promise<boolean> {
    const databaseId = (row.actionSnapshot as ApprovalActionSnapshot).ctx.databaseId;
    const database = await this.db.query.databases.findFirst({
      where: eq(databases.id, databaseId),
      columns: { id: true, spaceId: true },
    });
    const effective = database ? await this.access.effectiveForDatabase(membership, database) : null;
    return Boolean(effective);
  }

  async approve(workspaceId: string, id: string, actorId: string) {
    return toDto(await this.resolve(workspaceId, id, actorId, 'approved'));
  }

  async reject(workspaceId: string, id: string, actorId: string, reason?: string) {
    return toDto(await this.resolve(workspaceId, id, actorId, 'rejected', reason));
  }

  /**
   * #603 — the generic status-flip half of approve/reject, extracted so a
   * non-automation producer (agents.service.ts's `resolveGate`) can share it
   * too: atomic transition, approver-facing audit comment, expiry check.
   * What happens NEXT (apply the action, or just record a rejection) is
   * still producer-specific — `resolve()` below does it for automations/
   * write-back via the job queue; `AgentsService.resolveGate` does it
   * synchronously for agent runs (see that method for why it can't go
   * through the same async queue: an agent approval applies inline, in the
   * same request, matching the product behavior this ticket must not change).
   *
   * The transition is a single `UPDATE … WHERE status = 'pending' RETURNING
   * *`: under a concurrent double-approve, only the request that actually
   * flips the row gets `applied: true` back — the job queue's own
   * `idempotencyKey` uniqueness (used by `resolve()` below) is defense in
   * depth on top of this, not what makes either caller idempotent.
   */
  async decide(
    workspaceId: string,
    id: string,
    actorId: string,
    verdict: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ row: ApprovalRow; applied: boolean }> {
    const approval = await this.get(workspaceId, id);
    if (approval.status !== 'pending') return { row: approval, applied: false }; // already decided — idempotent no-op
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
      return { row: await this.get(workspaceId, id), applied: false };
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
    return { row: updated, applied: true };
  }

  /**
   * The automation/write-back half of approve/reject: decide, then dispatch
   * by kind. `agent_proposed_action` is refused HERE — before `decide()`
   * ever runs, so a wrong-endpoint call can't half-decide a row it then
   * can't act on — because applying it needs `AgentsService`, which this
   * module cannot import without a cycle (AgentsModule already imports
   * AutomationsModule the other way). Use `AgentsService.resolveGate` via
   * `POST /agents/runs/:run/approve|reject` for that kind instead.
   */
  private async resolve(
    workspaceId: string,
    id: string,
    actorId: string,
    verdict: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRow> {
    const approval = await this.get(workspaceId, id);
    const preSnapshot = approval.actionSnapshot as ApprovalActionSnapshot;
    if (preSnapshot.action.type === 'agent_proposed_action') {
      throw new UnprocessableEntityException(
        'This is an agent-run approval — resolve it via POST /agents/runs/:run/approve or /reject',
      );
    }

    const { row: updated, applied } = await this.decide(workspaceId, id, actorId, verdict, reason);
    if (!applied) return updated;

    const snapshot = updated.actionSnapshot as ApprovalActionSnapshot;
    if (verdict === 'approved') {
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
    } else if (snapshot.action.type === 'write_back_push') {
      // #282 AC — rejecting makes no outbound call (nothing enqueued above),
      // but is still recorded in the source's own run log, not only as an
      // approvals-table row: an append-only row per attempt (held/approved/
      // rejected/failed each their own), never a row mutated in place.
      const action = snapshot.action;
      await this.db.insert(sourceRuns).values({
        sourceId: action.source_id,
        workspaceId,
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'rejected',
        stats: { pushed: false, external_key: action.external_key, pushed_keys: Object.keys(action.values), approval_id: updated.id, decided_by: actorId, reason: reason ?? null },
      });
    } else if (snapshot.action.type === 'tyron_tool_call') {
      // #542 — the member is waiting in their own thread, not watching this
      // approval row; a rejection has to reach them there or it reads as
      // Tyron simply never answering. Direct insert (not TyronThreadsService.
      // appendMessage, which requires a Membership to assert thread
      // ownership) — this fires from a REJECTING ADMIN's request, who does
      // not own the member's thread and should not need to.
      const action = snapshot.action;
      await this.db.insert(tyronMessages).values({
        threadId: action.thread_id,
        role: 'assistant',
        content: `${action.message}\n\nA workspace admin reviewed this and said no.${reason ? ` Their reason: ${reason}` : ''}`,
      });
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
