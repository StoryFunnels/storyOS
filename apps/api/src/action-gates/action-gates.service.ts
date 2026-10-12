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

/**
 * #878 — THE registry of action classes an admin can declare a gate policy over, and the only
 * one. A class name cannot enforce anything without code behind it, so the declarable set is
 * exactly the set `check()`/`wouldGate()` can be called with: both take `EnforcedPolicyClass`,
 * which is `keyof` this object, so a call site for an unregistered class does not compile and a
 * class can only be declarable by being registered here. The create/enable routes read THIS
 * object for their allowlist; there is no second list.
 *
 * The remaining drift is a class registered here with no real enforcement behind it. That is
 * closed in `test/action-gates-unknown-class.test.ts`: its per-class proof table (declare, perform
 * the action as an agent, assert it is held) must have EXACTLY the registry's keys, asserted at
 * run time. (Not by the type checker: the API's `tsc` covers `src` only, which a mutation showed.)
 *
 * Not here on purpose: `source_push` and `publish_externally` are held by their own mechanisms
 * (a per-source flag, an automation action's class rules), not by a declared policy row.
 */
export const ENFORCED_POLICY_CLASSES = {
  [DELETE_RECORDS_ACTION_CLASS]: 'Records deleted by an agent, automation or MCP client are held for approval',
} as const;
export type EnforcedPolicyClass = keyof typeof ENFORCED_POLICY_CLASSES;
export const isEnforcedPolicyClass = (actionClass: string): actionClass is EnforcedPolicyClass =>
  Object.hasOwn(ENFORCED_POLICY_CLASSES, actionClass);

/** The 422 an admin sees at the moment they type a class nothing enforces. */
export function unsupportedClassMessage(actionClass: string): string {
  return `"${actionClass}" is not an action class a gate can enforce, so a policy on it would be listed as enabled and protect nothing. Supported classes: ${Object.keys(ENFORCED_POLICY_CLASSES).join(', ')}.`;
}

/**
 * #781 Phase 3 — the first "publish externally" action class, naming #282's
 * existing write-back push. Deliberately NOT routed through this service's
 * own `check()`/`resolvePolicy()` — #282's hold decision stays driven by its
 * own per-source `require_approval_for_push` flag (WriteBackSubscriber), not
 * a declared `action_gate_policies` row, and `check()`'s unconditional
 * human-bypass is NOT applied here either. Both of those are real, filed,
 * open product decisions (#803, #804) — this constant exists only so the
 * held action's snapshot carries the SAME shared action-class vocabulary
 * `ActionClassGateSnapshot` uses, not to opt `source_push` into this
 * service's policy/bypass behavior before those decisions land.
 */
export const SOURCE_PUSH_ACTION_CLASS = 'source_push';

export interface CheckGateInput {
  workspaceId: string;
  databaseId: string;
  actionClass: EnforcedPolicyClass;
  /** A person at the keyboard is never gated — see `check()`'s own doc. */
  source: ChangeSource;
  requesterActorId: string;
  recordIds: string[];
  /** For the approval card and notification snippet. */
  previewText: string;
  /**
   * #542 — a raw `softDeleteDatabaseCascade()` call (DatabasesService.remove,
   * SpacesService.remove) bypassed this gate entirely: it never went through
   * RecordsService.softDelete/batchDelete, so a `delete_records` policy on a
   * database was decorative against "delete the database instead". Absent
   * (the default) means an ordinary record delete/batch-delete, applied via
   * RecordsService.batchDelete on approval — unchanged. `'database_cascade'`
   * means the WHOLE database (records, fields, views) is held together and,
   * on approval, applied via DatabasesService's own cascade — see
   * ApprovalsService's registered executor for the branch.
   */
  scope?: 'database_cascade';
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
  private async resolvePolicy(workspaceId: string, databaseId: string, actionClass: EnforcedPolicyClass): Promise<PolicyRow | null> {
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
        ...(input.scope ? { scope: input.scope } : {}),
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

  /**
   * #542 — read-only version of `check()`'s own policy resolution, for a
   * caller that needs to know "would this be held" WITHOUT staging an
   * approval (no row inserted, no notification sent). SpacesService.remove()
   * uses this to pre-check every contained database before touching any of
   * them: a space's cascade delete spans multiple databases that could each
   * carry their own policy, and there is no atomic "hold N databases behind
   * one approval" mechanism yet — so a space delete that would gate ANY
   * contained database is refused whole, up front, rather than gating one
   * database while quietly deleting the others (a partial delete would be
   * worse than a refusal here, per this ticket's "never partial" rule).
   */
  async wouldGate(workspaceId: string, databaseId: string, actionClass: EnforcedPolicyClass, source: ChangeSource): Promise<boolean> {
    if (source === 'human') return false;
    const policy = await this.resolvePolicy(workspaceId, databaseId, actionClass);
    return Boolean(policy?.enabled);
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
    if (!isEnforcedPolicyClass(input.actionClass)) {
      throw new UnprocessableEntityException(unsupportedClassMessage(input.actionClass));
    }
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
    // #878 — a stored policy on a class nothing enforces (declared before this check existed) may
    // be disabled or deleted, never switched ON: enabling it would restore the false guarantee.
    if (patch.enabled === true && !isEnforcedPolicyClass(existing.actionClass)) {
      throw new UnprocessableEntityException(unsupportedClassMessage(existing.actionClass));
    }
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
