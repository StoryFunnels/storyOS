import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { approvals, databases, memberships } from '../db/schema';
import { currentEventOrigin, runWithCredential, runWithEventOrigin } from '../common/credential-context';
import type { EventOrigin } from '../common/credential-context';
import { describeEventOrigin } from '../common/describe-origin';
import { WriteHeldForApprovalException } from '../common/write-held-for-approval.exception';
import { loadAgentApprovalPolicy } from '../agents/agent-approval-policy';
import { resolveAgentIdentity } from '../agents/agent-identity';
import { NotificationsService } from '../notifications/notifications.service';
import { assertDatabaseInWorkspace } from '../records/database-scope';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { EffectiveRole } from '../access/access.service';

/**
 * #1178 — what an agent's own `approval_policy: delete` means for the DIRECT delete routes a Runner RUN CREDENTIAL can reach.
 *
 * Before this, that policy was read in exactly one place: where a SERVER-RUN agent stages a proposed action (agents.service.ts). A run
 * credential calling `DELETE …/records/:rec` (or a comment, an attachment, a source, a skill, a space view, "remove sample data")
 * directly was not held by it; only a manager-declared #542 gate could hold the two record routes, and nothing held the rest.
 *
 * ONE shared guard, called from INSIDE each service's delete after the service's own access checks (the place #542 checks, for the same
 * reason: REST, MCP and every future caller arrive there, so no route can forget it). It holds only when ALL of these are true:
 *   - the caller is a run credential: `currentEventOrigin()` is set ONLY for one (a person, an ordinary token, an automation and a
 *     server-run agent have no origin, so a server-run agent's own staging is never doubled);
 *   - the agent's policy (read live from its record) lists `delete`;
 *   - the delete is not the one a person just approved (`isApprovedAgentDelete`).
 * Then it stages ONE `approvals` row (snapshot `agent_delete`) and throws WriteHeldForApprovalException, which the API answers as 202
 * `{ pending_approval, approval_id, message }` (the #1104 shape). Nothing has been deleted.
 *
 * Applying on approval: each owning service registers an APPLIER for its `kind` (it already holds the dependencies and the real remove
 * method; this module may import none of them, because RecordsService and the rest call THIS service). `applyApproved` is the
 * `agent_delete` job executor's body: it re-resolves the workspace and the acting member NOW (#1029: the ids and the actor in a frozen
 * snapshot are data, not authority), then runs the applier as that member with the agent and run stamped on what it writes.
 */
export type AgentDeleteKind = 'record' | 'link' | 'comment' | 'attachment' | 'document' | 'source' | 'skill' | 'space_view' | 'sample_data';

/** The held delete, as frozen on the `approvals` row. `params` is whatever the kind's applier needs (ids only: never values). */
export interface AgentDeleteSnapshot {
  type: 'agent_delete';
  kind: AgentDeleteKind;
  database_id: string | null;
  record_id: string | null;
  /** What the card says is being deleted ("record \"Q3 plan\" in Tickets"). Descriptive: nothing is dispatched from it. */
  label: string;
  params: Record<string, unknown>;
  agent_id: string;
  agent_name: string;
}

export interface AgentDeleteApplyInput {
  workspaceId: string;
  /** The acting member, resolved live and active. */
  membership: Membership;
  actorId: string;
  params: Record<string, unknown>;
  databaseId: string | null;
  recordId: string | null;
  agentId: string;
  agentName: string;
}
export type AgentDeleteApplier = (input: AgentDeleteApplyInput) => Promise<void>;

export interface HoldAgentDeleteInput {
  workspaceId: string;
  kind: AgentDeleteKind;
  /** The member the credential acts as (the delete's actor). */
  actorId: string;
  databaseId?: string | null;
  recordId?: string | null;
  label: string;
  params: Record<string, unknown>;
}

/**
 * The role the acting member must STILL hold on the database (or the record) when a held delete is applied: the same minimum the REST
 * route asserted when it was staged. Kinds absent here are workspace-level (document, skill, space view, sample data) and re-check
 * inside their own service method, which already takes the membership.
 */
const ROLE_ON_APPLY: Partial<Record<AgentDeleteKind, EffectiveRole>> = { record: 'editor', link: 'editor', comment: 'commenter', attachment: 'editor', source: 'creator' };

/** The delete inside `fn` is the one a person just APPROVED: it must not be held again (it would stage a second approval forever). */
const approvedDelete = new AsyncLocalStorage<true>();
export const asApprovedAgentDelete = <T>(fn: () => T): T => approvedDelete.run(true, fn);
export const isApprovedAgentDelete = (): boolean => approvedDelete.getStore() === true;

@Injectable()
export class AgentDeleteHoldService {
  private readonly logger = new Logger(AgentDeleteHoldService.name);
  private readonly appliers = new Map<AgentDeleteKind, AgentDeleteApplier>();
  private accessCheck: ((membership: Membership, databaseId: string, recordId: string | null, min: EffectiveRole) => Promise<void>) | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /** Called once per kind by the service that owns the delete (onModuleInit). A second registration for a kind is a bug. */
  registerApplier(kind: AgentDeleteKind, applier: AgentDeleteApplier): void {
    if (this.appliers.has(kind)) throw new Error(`an agent-delete applier for "${kind}" is already registered`);
    this.appliers.set(kind, applier);
  }

  /**
   * Set once by RecordsService (it owns THE record/database access rule, `assertRecordAccess`; this module cannot import it). With a
   * record id the check is the record's, without one the database's.
   */
  setAccessCheck(check: NonNullable<AgentDeleteHoldService['accessCheck']>): void {
    this.accessCheck = check;
  }

  /** The kinds that can be applied: the test asserts every `@HoldsAgentDeletes` kind is here. */
  registeredKinds(): AgentDeleteKind[] {
    return [...this.appliers.keys()];
  }

  /**
   * Hold the delete when a run credential's agent has the `delete` policy: stage the approval and THROW (202). Returns normally when the
   * delete should go ahead: not a run credential, no `delete` in the policy, or the delete a person approved.
   */
  async holdIfAgentPolicy(input: HoldAgentDeleteInput): Promise<void> {
    if (isApprovedAgentDelete()) return;
    const origin = currentEventOrigin();
    if (!origin?.agentId) return;
    const policy = await loadAgentApprovalPolicy(this.db, input.workspaceId, origin.agentId);
    if (!policy.has('delete')) return;

    // The approver is the agent's OWNER, resolved now (the member the credential acts as), like the #1104 write gate; any workspace
    // admin may also decide (ApprovalsController). Fail closed: a held delete with nobody able to clear it is never a performed one.
    const identity = await resolveAgentIdentity(this.db, input.workspaceId, origin.agentId);
    const approverId = identity?.ownerId ?? input.actorId;
    const agentName = identity?.agentName ?? origin.agentName ?? 'An agent';
    const caused = await describeEventOrigin(this.db, { ...origin, agentName });
    const previewText = `${caused}delete ${input.label}`;

    const action: AgentDeleteSnapshot = {
      type: 'agent_delete',
      kind: input.kind,
      database_id: input.databaseId ?? null,
      record_id: input.recordId ?? null,
      label: input.label,
      params: input.params,
      agent_id: origin.agentId,
      agent_name: agentName,
    };
    const [created] = await this.db
      .insert(approvals)
      .values({
        workspaceId: input.workspaceId,
        ruleId: null,
        runId: null,
        recordId: input.recordId ?? null,
        actionIndex: 0,
        actionSnapshot: {
          action,
          ctx: { workspaceId: input.workspaceId, databaseId: input.databaseId ?? null, recordId: input.recordId ?? null, actorId: input.actorId, origin },
        },
        previewText,
        approverId,
      })
      .returning();

    await this.notifications
      .notify({
        workspaceId: input.workspaceId,
        databaseId: input.databaseId ?? undefined,
        recordId: input.recordId ?? undefined,
        actorId: input.actorId,
        type: 'action_approval_requested',
        recipients: [approverId],
        snippet: previewText.slice(0, 140),
        refId: created!.id,
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`agent-delete notify failed: ${String(error)}`));

    throw new WriteHeldForApprovalException(
      created!.id,
      'This delete is held for approval by the agent\'s own delete policy. It has not happened yet; a person must approve it.',
    );
  }

  /**
   * The `agent_delete` executor's body: run once a person has approved. The acting member and the database are re-checked HERE, now,
   * not trusted from the snapshot. An actor who is no longer an active member refuses (422): the delete runs as that member, with
   * that member's rights, exactly as the REST call would have.
   */
  async applyApproved(action: AgentDeleteSnapshot, ctx: { workspaceId: string; actorId: string; origin?: EventOrigin | null }): Promise<void> {
    const applier = this.appliers.get(action.kind);
    if (!applier) throw new UnprocessableEntityException(`No applier is registered for a held "${action.kind}" delete; nothing was deleted`);
    if (action.database_id) await assertDatabaseInWorkspace(this.db, ctx.workspaceId, action.database_id);
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, ctx.actorId), eq(memberships.status, 'active')),
    });
    if (!membership) {
      throw new UnprocessableEntityException('The member this agent acts as is no longer an active member of the workspace; the held delete was not applied');
    }
    const min = ROLE_ON_APPLY[action.kind];
    if (min && action.database_id) {
      if (!this.accessCheck) throw new UnprocessableEntityException('Access cannot be re-checked right now; nothing was deleted');
      await this.accessCheck(membership as Membership, action.database_id, action.record_id, min);
    }
    const origin = ctx.origin ?? null;
    const run = origin ? { runId: origin.runId, runnerId: origin.runnerId, runnerName: origin.runnerName, depth: 0 } : null;
    const input: AgentDeleteApplyInput = {
      workspaceId: ctx.workspaceId,
      membership: membership as Membership,
      actorId: ctx.actorId,
      params: action.params,
      databaseId: action.database_id,
      recordId: action.record_id,
      agentId: action.agent_id,
      agentName: action.agent_name,
    };
    // As the agent, for the audit: the request-shaped context a REST call would have had (actor source `agent`, the run and Runner), and
    // the origin so what the delete causes (an automation) is still held at its outward steps. `approved` keeps THIS delete from being held.
    await runWithCredential(
      null,
      () => runWithEventOrigin(origin, () => asApprovedAgentDelete(() => applier(input))),
      { userId: ctx.actorId, source: 'agent', agentId: action.agent_id, agentName: action.agent_name },
      run,
    );
  }

  /** A database name for a card; falls back to nothing (the caller words the label without it). */
  async databaseName(databaseId: string): Promise<string | null> {
    const row = await this.db.query.databases.findFirst({ where: eq(databases.id, databaseId), columns: { name: true } });
    return row?.name ?? null;
  }
}
