import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { actionGatePolicies, approvals, databases, memberships, type ChangeSource } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';

type PolicyRow = typeof actionGatePolicies.$inferSelect;

/**
 * #542 Phase 2 — "delete records" is the first action class this covers; the
 * `actionClass` column is free text specifically so Phase 3 (publish, spend)
 * needs no migration to add.
 */
export const DELETE_RECORDS_ACTION_CLASS = 'delete_records';

export interface CheckGateInput {
  workspaceId: string;
  databaseId: string;
  actionClass: string;
  /** A person at the keyboard is never gated — see `check()`'s own doc. */
  source: ChangeSource;
  requesterActorId: string;
  recordIds: string[];
  /** For the approval card and notification snippet. */
  previewText: string;
}

export type CheckGateResult = { held: false } | { held: true; approvalId: string };

/**
 * Deliberately its own module with ZERO dependency on AutomationsModule (or
 * anything that transitively imports RecordsModule): `RecordsService` itself
 * needs to call `check()` before a delete proceeds, and `AutomationsModule`
 * (home of `ApprovalsService`, which is what actually APPLIES an approved
 * gate) already imports `RecordsModule` — so the reverse edge here would be
 * a cycle. `DB` and `NotificationsService` are both `@Global()`, so this
 * needs no module import at all beyond its own providers.
 *
 * This inserts directly into the shared `approvals` table (matching the
 * shape `ApprovalsService.createRow` already uses) rather than depending on
 * `ApprovalsService` for that insert — the one piece of light duplication
 * that buys the missing module edge back.
 */
@Injectable()
export class ActionGatesService {
  private readonly logger = new Logger(ActionGatesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  /** Database-scoped row beats space-scoped beats workspace-scoped — the
   * most specific declared policy wins, matching `access_grants`' own
   * scope-resolution precedent. */
  private async resolvePolicy(workspaceId: string, databaseId: string, actionClass: string): Promise<PolicyRow | null> {
    const database = await this.db.query.databases.findFirst({ where: eq(databases.id, databaseId) });
    const spaceId = database?.spaceId;

    const rows = await this.db.query.actionGatePolicies.findMany({
      where: and(eq(actionGatePolicies.workspaceId, workspaceId), eq(actionGatePolicies.actionClass, actionClass)),
    });
    const byDatabase = rows.find((r) => r.databaseId === databaseId);
    if (byDatabase) return byDatabase;
    const bySpace = spaceId ? rows.find((r) => r.spaceId === spaceId && r.databaseId === null) : undefined;
    if (bySpace) return bySpace;
    return rows.find((r) => r.spaceId === null && r.databaseId === null) ?? null;
  }

  /**
   * The gate itself. `source === 'human'` always allows, unconditionally and
   * first — a person at the keyboard is stamped `human` at the auth
   * boundary (never a client-supplied flag this function could be fooled
   * by), so this is a structural guarantee, not a policy choice this
   * function is making. Anything else (agent/automation/mcp) is checked
   * against the resolved policy; no policy or a disabled one allows too.
   */
  async check(input: CheckGateInput): Promise<CheckGateResult> {
    if (input.source === 'human') return { held: false };

    const policy = await this.resolvePolicy(input.workspaceId, input.databaseId, input.actionClass);
    if (!policy || !policy.enabled) return { held: false };

    const snapshot = {
      action: {
        type: 'action_class_gate' as const,
        action_class: input.actionClass,
        database_id: input.databaseId,
        record_ids: input.recordIds,
        requester_source: input.source,
      },
      ctx: {
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: input.recordIds.length === 1 ? input.recordIds[0]! : null,
        actorId: input.requesterActorId,
      },
    };

    const [created] = await this.db
      .insert(approvals)
      .values({
        workspaceId: input.workspaceId,
        ruleId: null,
        runId: null,
        recordId: snapshot.ctx.recordId,
        actionIndex: 0,
        actionSnapshot: snapshot,
        previewText: input.previewText,
        approverId: policy.approverId,
      })
      .returning();

    await this.notifications
      .notify({
        workspaceId: input.workspaceId,
        databaseId: input.databaseId,
        recordId: snapshot.ctx.recordId ?? undefined,
        actorId: input.requesterActorId,
        type: 'action_approval_requested',
        recipients: [policy.approverId],
        snippet: input.previewText.slice(0, 140),
        refId: created!.id,
        allowSelf: true,
      })
      .catch((error: unknown) => this.logger.warn(`action-gate notify failed: ${String(error)}`));

    return { held: true, approvalId: created!.id };
  }

  async list(workspaceId: string): Promise<PolicyRow[]> {
    return this.db.query.actionGatePolicies.findMany({
      where: eq(actionGatePolicies.workspaceId, workspaceId),
      orderBy: desc(actionGatePolicies.createdAt),
    });
  }

  /** Refuses an approver who isn't a real, active admin of this workspace —
   * the ticket's own lockout-prevention AC: a gate can never be declared
   * with nobody able to clear it. Checked here, at declaration time, rather
   * than resolved dynamically at check() time — an explicit, named admin is
   * a decision an operator makes, not a fallback this service guesses. */
  private async assertResolvableApprover(workspaceId: string, approverId: string): Promise<void> {
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, approverId)),
    });
    if (!membership || membership.role !== 'admin' || membership.status !== 'active') {
      throw new UnprocessableEntityException(
        'A gate policy must name a real, active admin of this workspace as its approver — otherwise it could never be cleared',
      );
    }
  }

  async create(input: {
    workspaceId: string;
    spaceId: string | null;
    databaseId: string | null;
    actionClass: string;
    approverId: string;
    createdBy: string;
  }): Promise<PolicyRow> {
    await this.assertResolvableApprover(input.workspaceId, input.approverId);
    const [created] = await this.db
      .insert(actionGatePolicies)
      .values({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        databaseId: input.databaseId,
        actionClass: input.actionClass,
        approverId: input.approverId,
        createdBy: input.createdBy,
      })
      .returning();
    return created!;
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { enabled?: boolean; approverId?: string },
  ): Promise<PolicyRow> {
    const existing = await this.db.query.actionGatePolicies.findFirst({
      where: and(eq(actionGatePolicies.id, id), eq(actionGatePolicies.workspaceId, workspaceId)),
    });
    if (!existing) throw new NotFoundException('Gate policy not found');

    const nextApproverId = patch.approverId ?? existing.approverId;
    const nextEnabled = patch.enabled ?? existing.enabled;
    if (nextEnabled) await this.assertResolvableApprover(workspaceId, nextApproverId);

    const [updated] = await this.db
      .update(actionGatePolicies)
      .set({ ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.approverId ? { approverId: patch.approverId } : {}) })
      .where(eq(actionGatePolicies.id, id))
      .returning();
    return updated!;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.query.actionGatePolicies.findFirst({
      where: and(eq(actionGatePolicies.id, id), eq(actionGatePolicies.workspaceId, workspaceId)),
    });
    if (!existing) throw new NotFoundException('Gate policy not found');
    await this.db.delete(actionGatePolicies).where(eq(actionGatePolicies.id, id));
  }
}
