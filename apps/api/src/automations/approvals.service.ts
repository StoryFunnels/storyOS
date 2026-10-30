import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { AgentWakesService } from '../runners/agent-wakes.service';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, automations, databases, memberships, sourceRuns, tyronMessages, type ChangeSource } from '../db/schema';
import type { EventOrigin } from '../common/credential-context';
import { CommentsService } from '../comments/comments.service';
import { NotificationsService, type NotificationType } from '../notifications/notifications.service';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';
import { DatabasesService } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { AgentPrincipal } from '../agents/agent-principal';
import type { AgentStep, ProposedAction } from '../agents/agent-runtime';
import { JobRunnerService } from './job-runner.service';
import type { ActionEffect } from './actions.service';
import { maskUserinfoInText, presentActionHeaders } from '../common/webhook-headers';
import type { AgentWriteGateSnapshot } from '../action-gates/agent-write-gates.service';
import { resolveAgentIdentity } from '../agents/agent-identity';
import { assertDatabaseInWorkspace } from '../records/database-scope';
import { asApprovedAgentWrite } from '../records/agent-write-context';
import { AgentDeleteHoldService } from '../action-gates/agent-delete-hold.service';
import type { AgentDeleteSnapshot } from '../action-gates/agent-delete-hold.service';
import { describeEventOrigin } from '../common/describe-origin';

type ApprovalRow = typeof approvals.$inferSelect;

/**
 * #1009 — an approval that is STILL WAITING for a decision: pending and not past its expiry. A pending row past `expires_at` is
 * flipped to `expired` by a sweep, so for a moment it is still `pending` in the table but nobody can decide it; counting it would make a
 * run read "Awaiting approval" for something that can no longer be approved. One definition, used by the runs list/detail and by `count`.
 */
export const waitingApprovalCondition = () => and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, new Date()));

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
  /**
   * #781 Phase 3 — tags this snapshot with the shared action-class
   * vocabulary `ActionClassGateSnapshot` uses, so a held write-back push is
   * visible/queryable alongside every other action-class gate. Descriptive
   * only: dispatch (approve/reject/apply) stays on `type`, registered by
   * WriteBackSubscriber exactly as before — adding this field changes no
   * behavior. See SOURCE_PUSH_ACTION_CLASS's own doc for what's deliberately
   * NOT changed alongside it (policy, human-bypass — both filed as #803/#804).
   */
  action_class: string;
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

/**
 * #542 Phase 2 — a workspace-declared action-class gate's held action, the
 * fifth producer. Approved via a registered JobRunnerService executor (see
 * `onModuleInit` below), same as the other producers — `ApprovalsService`
 * already has a safe dependency on `RecordsService` and (as of #542's
 * cascade-delete-bypass fix) `DatabasesService` too, both via
 * AutomationsModule's existing imports of RecordsModule/DatabasesModule.
 *
 * `record_ids` is always an array (length 1 for a single-record delete) so
 * approve/reject/preview code has one shape regardless of which entry point
 * (`RecordsController.remove` vs `.batchDelete`) produced it.
 */
export interface ActionClassGateSnapshot {
  type: 'action_class_gate';
  action_class: string;
  database_id: string;
  record_ids: string[];
  requester_source: string;
  /** #542 — absent (the default) means an ordinary record delete/batch-delete,
   * applied via RecordsService.batchDelete on approval. `'database_cascade'`
   * means the WHOLE database (records, fields, views) was held together —
   * `softDeleteDatabaseCascade` bypassed the gate entirely before this fix —
   * and is applied via DatabasesService.applyRemove on approval instead. */
  scope?: 'database_cascade';
}

/**
 * #867 AC3 — an AI's proposal to make a skill PUBLIC (an unauthenticated link). The skill is NOT
 * public until a person approves this in the Inbox; approval is human-sourced only (#859), so the
 * proposing token cannot approve it. Has no database (`ctx.databaseId` is null) and no record.
 */
export interface SkillPublishPublicSnapshot {
  type: 'skill_publish_public';
  skill_id: string;
  skill_name: string;
  requester_source: string;
}

/** The FROZEN payload a gated action carries between "queued for approval"
 * and "approved" — `action` has every {Field}/{payload} token already
 * interpolated (actions.service.ts renders it before calling `create()`
 * below), and `ctx` is the same shape automation_jobs.payload.ctx already
 * uses so JobRunnerService's executors don't need a second code path. */
export interface ApprovalActionSnapshot {
  action: AutomationAction | WriteBackPushAction | AgentProposedActionSnapshot | TyronToolCallSnapshot | ActionClassGateSnapshot | SkillPublishPublicSnapshot | AgentWriteGateSnapshot | AgentDeleteSnapshot;
  /** `databaseId` is null for an approval that belongs to no database (a skill, #867). */
  ctx: {
    workspaceId: string;
    databaseId: string | null;
    recordId: string | null;
    actorId: string;
    /** #1174 — the agent and Runner run that caused the event this action came from; absent when a person (or an automation) did. */
    origin?: EventOrigin | null;
  };
}

export interface CreateApprovalInput {
  workspaceId: string;
  databaseId: string | null;
  ruleId: string | null;
  runId: string | null;
  recordId: string | null;
  actionIndex: number;
  /** Already rendered — see ApprovalActionSnapshot's doc. */
  action: AutomationAction | WriteBackPushAction | AgentProposedActionSnapshot | TyronToolCallSnapshot | SkillPublishPublicSnapshot;
  previewText: string;
  /** The rule's run actor (or the button-presser, when there's no rule) —
   * used as the approver only when no rule (and hence no owner) exists. */
  requesterActorId: string;
  /**
   * #1174 / ADR-0021 §7 — the run credential that CAUSED this (an agent's write fired the rule). Named on the card (the preview
   * text) and kept in the snapshot's ctx, so the approver sees WHICH agent and WHICH run before deciding.
   */
  origin?: EventOrigin | null;
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

/** #1068 — a rendered send_webhook/http_request snapshot holds the real header values
 * and URL userinfo. The API returns them masked; execution reads the row itself. */
function presentSnapshot(snapshot: unknown): unknown {
  const snap = snapshot as Partial<ApprovalActionSnapshot> | null;
  if (!snap || typeof snap !== 'object' || !snap.action) return snapshot;
  // #1174 — the stored origin is camelCase (it rides in job payloads); the API speaks snake_case.
  const o = snap.ctx?.origin;
  const ctx = snap.ctx && o ? { ...snap.ctx, origin: { agent_id: o.agentId, agent_name: o.agentName, run_id: o.runId, runner_id: o.runnerId, runner_name: o.runnerName } } : snap.ctx;
  return { ...snap, ...(ctx ? { ctx } : {}), action: presentActionHeaders([snap.action])[0] };
}

function toDto(row: ApprovalRow) {
  return {
    id: row.id,
    rule_id: row.ruleId,
    run_id: row.runId,
    record_id: row.recordId,
    action_index: row.actionIndex,
    action_snapshot: presentSnapshot(row.actionSnapshot),
    preview_text: maskUserinfoInText(row.previewText),
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
/** What a decided agent-write approval carries to the wake it causes. */
interface AgentWriteDecision {
  approval_id: string;
  verdict: 'approved' | 'rejected';
  decided_by: string;
  reason?: string | null;
}

@Injectable()
export class ApprovalsService implements OnModuleInit {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly comments: CommentsService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobRunnerService,
    private readonly access: AccessService,
    // #542 Phase 2 — safe: AutomationsModule already imports RecordsModule
    // one-way (automation actions write records today), so this adds no new
    // module edge. Used only to APPLY an already-approved 'action_class_gate'
    // (see onModuleInit below) — the CHECK half lives in the separate,
    // dependency-free ActionGatesService that RecordsService itself calls,
    // which is what keeps that direction from becoming a cycle.
    private readonly records: RecordsService,
    // #542 — same reasoning as `records` above: AutomationsModule already
    // imports DatabasesModule one-way, so this is a free edge, not a new
    // cycle. Applies an approved 'database_cascade' gate (see onModuleInit).
    private readonly databases: DatabasesService,
    // ticket #1130 / ADR-0021 §1: a decided approval the agent ASKED for (a held write) wakes that agent. RunnersModule is global.
    private readonly agentWakes: AgentWakesService,
    // #1178 — applies an approved agent_delete through the applier the owning service registered (action-gates module is @Global).
    private readonly agentDeletes: AgentDeleteHoldService,
  ) {}

  /** Registers the executor JobRunnerService.enqueue() looks up by `kind`
   * when `resolve()` below approves an 'action_class_gate' snapshot — same
   * registration pattern TyronService uses for 'tyron_tool_call'. */
  onModuleInit(): void {
    // #1104 — a per-agent record create/update held by AgentWriteGatesService. Same executor registry as the other gates:
    // approving enqueues it from the server-side snapshot (never from anything the approver or the agent sends).
    this.jobs.registerExecutor('agent_write_gate', async (payload) => {
      const { action, ctx, decision } = payload as { action: AgentWriteGateSnapshot; ctx: ApprovalActionSnapshot['ctx']; decision?: AgentWriteDecision };
      await this.applyAgentWriteGate(action, ctx.workspaceId);
      // Approved AND applied: only now does the agent have something new to look at, so wake it after the write, not before.
      if (decision) await this.wakeAgentAfterDecision(ctx.workspaceId, action, decision);
    });
    // #1178 — a direct delete an agent's run credential made, held by the agent's own `delete` policy. Approving enqueues it from the
    // server-side snapshot; the owning service's applier performs it as the acting member, with the agent and run on the audit row.
    this.jobs.registerExecutor('agent_delete', async (payload) => {
      const { action, ctx } = payload as { action: AgentDeleteSnapshot; ctx: ApprovalActionSnapshot['ctx'] };
      await this.agentDeletes.applyApproved(action, { workspaceId: ctx.workspaceId, actorId: ctx.actorId, origin: ctx.origin ?? null });
    });
    this.jobs.registerExecutor('action_class_gate', async (payload) => {
      const { action, ctx } = payload as { action: ActionClassGateSnapshot; ctx: ApprovalActionSnapshot['ctx'] };
      // #542 — a database-cascade delete was held whole (records, fields,
      // views together); applying it is DatabasesService's own cascade, not
      // a plain record batch-delete, or the database/fields/views would
      // never actually get marked deleted once approved.
      if (action.scope === 'database_cascade') {
        await this.databases.applyRemove(action.database_id);
        return;
      }
      // Preserve the TRUE original source (agent/automation/mcp) rather than
      // guessing — the whole point of #357's ChangeSource work is that this
      // stays attributable through an approval detour, not collapsed to one
      // generic value once a human has signed off on it.
      await this.records.batchDelete(
        ctx.workspaceId,
        action.database_id,
        action.record_ids,
        ctx.actorId,
        action.requester_source as ChangeSource,
        // Already approved — re-checking here would find the SAME policy
        // still enabled and stage a second approval forever instead of ever
        // deleting anything.
        true,
      );
    });
  }

  /**
   * ticket #1130 / ADR-0021 §1 — "an approval the agent asked for being decided" wakes the agent, with the verdict on the wake.
   * Idempotent on the approval id (a retried job or a replayed decision never makes a second wake). A wake that is refused (the
   * agent is not a Your-own-AI agent, its owner left) is the queue's rule working: it must not fail the decision.
   */
  private async wakeAgentAfterDecision(workspaceId: string, action: AgentWriteGateSnapshot, decision: AgentWriteDecision): Promise<void> {
    try {
      await this.agentWakes.enqueue({
        workspaceId,
        agentId: action.agent_id,
        reason: 'approval_decided',
        recordId: action.record_id,
        requestedBy: decision.decided_by,
        sourceKey: `approval:${decision.approval_id}`,
        detail: { approval_id: decision.approval_id, verdict: decision.verdict, ...(decision.reason ? { reason: decision.reason } : {}) },
        context: { approval: { id: decision.approval_id, verdict: decision.verdict, ...(decision.reason ? { reason: decision.reason } : {}) } },
        materialize: true,
      });
    } catch (error) {
      this.logger.warn(`could not wake agent ${action.agent_id} after approval ${decision.approval_id}: ${String(error)}`);
    }
  }

  /**
   * #1104 — apply an APPROVED per-agent write gate: exactly the staged inputs, nothing the agent adds later.
   *
   * The ids in the snapshot are data, not authority, so before writing anything this re-checks, against the approval's own
   * workspace and the world as it is NOW: the database still belongs to the workspace (#1029), the agent record is still
   * live and its owner is still an active member, and that owner can still write to the database (and the record, for an
   * update). Any failure leaves the record untouched and fails the job. The write then goes through RecordsService with
   * source 'agent' (provenance survives the approval) and the one-shot bypass that keeps it from being held again.
   */
  private async applyAgentWriteGate(action: AgentWriteGateSnapshot, workspaceId: string): Promise<void> {
    await assertDatabaseInWorkspace(this.db, workspaceId, action.database_id);
    const identity = await resolveAgentIdentity(this.db, workspaceId, action.agent_id);
    if (!identity) {
      throw new UnprocessableEntityException('This agent no longer exists or its owner is no longer an active member; the held write was not applied');
    }
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, identity.ownerId), eq(memberships.status, 'active')),
    });
    if (!membership) {
      throw new UnprocessableEntityException('The agent\'s owner is no longer an active member; the held write was not applied');
    }
    await this.databases.assertAccess(membership, action.database_id, 'contributor');
    await asApprovedAgentWrite(async () => {
      if (action.operation === 'update') {
        const recordId = action.record_id;
        if (!recordId) throw new UnprocessableEntityException('This held update names no record');
        await this.records.assertRecordAccess(membership, action.database_id, recordId, 'contributor');
        await this.records.update(workspaceId, action.database_id, recordId, action.inputs[0] ?? {}, identity.ownerId, 0, 'agent', action.agent_id, identity.agentName, membership);
      } else {
        await this.records.createBatch(workspaceId, action.database_id, action.inputs, identity.ownerId, 0, {
          source: 'agent',
          agentId: action.agent_id,
          agentName: identity.agentName,
          membership,
        });
      }
    });
  }

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

  /** #1174 — 'Caused by agent "X" (run 12): ' — the sentence an approver reads first. The run's public number is looked up live. */
  private describeOrigin(origin: EventOrigin): Promise<string> {
    return describeEventOrigin(this.db, origin);
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
    // #1068 — the preview names the webhook URL; its userinfo must not reach the
    // stored preview or the approver's notification.
    const causedBy = input.origin ? await this.describeOrigin(input.origin) : '';
    const previewText = maskUserinfoInText(`${causedBy}${input.previewText}`);
    const approverId = await this.approverFor(input.ruleId, input.requesterActorId);
    const snapshot: ApprovalActionSnapshot = {
      action: input.action,
      ctx: {
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: input.recordId,
        actorId: input.requesterActorId,
        ...(input.origin ? { origin: input.origin } : {}),
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
        previewText,
        approverId,
      })
      .returning();

    await this.notifications
      .notify({
        workspaceId: input.workspaceId,
        databaseId: input.databaseId ?? undefined,
        recordId: input.recordId ?? undefined,
        actorId: input.requesterActorId,
        type: input.notification?.type ?? 'action_approval_requested',
        recipients: [approverId],
        snippet: input.notification?.snippet ?? previewText.slice(0, 140),
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
      summary: `Waiting for approval (approval ${created.id}): ${created.previewText}`,
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
    const scoped =
      visible === null
        ? rows
        : rows.filter((r) => {
            const databaseId = (r.actionSnapshot as ApprovalActionSnapshot).ctx.databaseId;
            return databaseId !== null && visible.has(databaseId); // a database-less approval (a skill) is not a guest's to see
          });
    return scoped.map(toDto);
  }

  /**
   * #1009 — how many approvals match, for the "N waiting for your approval" bar. `list()` above is capped at 100 rows and says nothing
   * when it was cut, so a count taken from its length is wrong past 100. This counts in SQL, with the SAME per-database scope `list()`
   * applies (a guest sees only approvals on databases they can see). `status=pending` means waiting: pending and not yet expired.
   */
  async count(membership: Membership, status?: string): Promise<{ total: number }> {
    const visible = await this.access.visibleDatabaseIds(membership);
    if (visible !== null && visible.size === 0) return { total: 0 };
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, membership.workspaceId),
          status === 'pending' ? waitingApprovalCondition() : status ? eq(approvals.status, status) : undefined,
          visible === null
            ? undefined
            : sql`(${approvals.actionSnapshot} #>> '{ctx,databaseId}') IN (${sql.join([...visible].map((id) => sql`${id}`), sql`, `)})`,
        ),
      );
    return { total: row?.total ?? 0 };
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
    if (databaseId === null) return false;
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
    if (!applied) {
      // #869 — NOT applied means this approval was already decided (or expired, or a concurrent
      // decision won). The same decision again is an idempotent no-op (a double click), but the
      // OPPOSITE decision must be REFUSED with the reason, never returned as a success: a person who
      // realises too late and clicks Reject was told "Rejected" while the approved action stayed in
      // force. A security control that says "done" and does nothing is the dangerous half (MN-125).
      if (updated.status === (verdict === 'approved' ? 'approved' : 'rejected')) return updated;
      throw new ConflictException(
        updated.status === 'expired'
          ? 'This approval expired and can no longer be decided.'
          : `This approval was already ${updated.status}, so it cannot be ${verdict}. A decision here is final; ` +
            'to undo what it did, change that thing directly.',
      );
    }

    const snapshot = updated.actionSnapshot as ApprovalActionSnapshot;
    if (verdict === 'approved') {
      await this.jobs.enqueue({
        workspaceId,
        ruleId: updated.ruleId,
        runId: updated.runId,
        actionIndex: updated.actionIndex,
        kind: snapshot.action.type,
        payload: {
          action: snapshot.action,
          ctx: snapshot.ctx,
          // The person who decided, carried to the executor so the agent's wake is made as THEIR action (the access check's subject).
          decision: { approval_id: updated.id, verdict: 'approved', decided_by: actorId } satisfies AgentWriteDecision,
        },
        idempotencyKey: `approval:${updated.id}`,
        approvalId: updated.id,
      });
    } else if (snapshot.action.type === 'agent_write_gate') {
      // Rejected: nothing is applied, but the agent asked and was told no, so it is woken to read the answer (and the reason).
      await this.wakeAgentAfterDecision(workspaceId, snapshot.action, { approval_id: updated.id, verdict: 'rejected', decided_by: actorId, reason: reason ?? null });
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
