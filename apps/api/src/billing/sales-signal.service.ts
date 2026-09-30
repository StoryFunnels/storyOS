import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, memberships, user, workspaces } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { env } from '../config/env';
import { EmailService } from '../mail/email.service';
import { AccessService } from '../access/access.service';
import { BillingService } from './billing.service';

export type SalesSignalReason = 'free_seats_blocked' | 'pro_five_seats' | 'fifth_database';

/**
 * #650 AC2 — a soft, informational touch (email + an admin-visible flag,
 * never a hard paywall) for a workspace whose usage pattern looks like a
 * Business/Enterprise-track account. Three real, one-time events fire it,
 * defined by Mira 2026-09-29 against the real plan catalogue rather than an
 * invented threshold — see plans.ts:
 *
 *  - A Free workspace's `add_seat` capability check rejects (already-existing
 *    logic in EntitlementsService.can — this service is called from AT that
 *    rejection, not from new detection logic, per the AC's own instruction).
 *  - A Pro workspace's billable seat count reaches 5 (Business's own
 *    includedSeats) — checked by the caller right after a seat is actually
 *    added (invite accepted, or a guest promoted), since `can('add_seat')`
 *    always allows Pro to add another seat; there's no natural rejection to
 *    hook here.
 *  - A Free or Pro workspace's 5th (non-system) database.
 *
 * ONE combined signal per workspace, not one per reason: `maybeFire` claims
 * `workspaces.salesSignalSentAt` atomically (same UPDATE...WHERE...RETURNING
 * shape as OnboardingNudgeService/TrialRemindersService), so whichever of the
 * three fires FIRST is the one recorded and mailed — a workspace already
 * flagged never re-fires for a different reason, matching "fire once per
 * workspace lifetime" literally.
 */
@Injectable()
export class SalesSignalService {
  private readonly logger = new Logger(SalesSignalService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly email: EmailService,
    private readonly access: AccessService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Pro-only: `can('add_seat')` always allows Pro another seat (MN-190 —
   * Free is the only real ceiling), so there is no natural rejection to hook
   * for this signal the way `free_seats_blocked` hooks one. Callers invoke
   * this right after a seat is actually added (an invite accepted, a guest
   * promoted) — checking the COUNT AFTER the change, since "reaches 5" means
   * the result, not the attempt. Each of those actions adds at most one
   * billable seat, so `=== 5` is the exact crossing (4 -> 5), not `>= 5` —
   * the latter would also match every seat added after the fifth.
   */
  async checkSeatCrossing(workspaceId: string): Promise<void> {
    try {
      const status = await this.billing.getStatus(workspaceId);
      if (status.plan !== 'pro') return;
      const billableSeats = (await this.access.billableUserIds(workspaceId)).length;
      if (billableSeats === 5) await this.maybeFire(workspaceId, 'pro_five_seats');
    } catch (error) {
      this.logger.warn(`sales-signal seat-crossing check failed for ${workspaceId}: ${String(error)}`);
    }
  }

  /**
   * Free or Pro: StoryOS has no database-count cap on any plan (plans.ts's
   * own comment — unlimited records is load-bearing everywhere), so unlike
   * the seat signal this is a judgment call about usage shape, not an
   * enforced limit. Same exact-crossing reasoning as checkSeatCrossing:
   * `create()` adds exactly one database, so `=== 5` is the crossing.
   */
  async checkDatabaseCrossing(workspaceId: string): Promise<void> {
    try {
      const status = await this.billing.getStatus(workspaceId);
      if (status.plan !== 'free' && status.plan !== 'pro') return;
      const rows = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(databases)
        .where(and(eq(databases.workspaceId, workspaceId), eq(databases.isSystem, false), notDeleted(databases.deletedAt)));
      if (rows[0]?.count === 5) await this.maybeFire(workspaceId, 'fifth_database');
    } catch (error) {
      this.logger.warn(`sales-signal database-crossing check failed for ${workspaceId}: ${String(error)}`);
    }
  }

  /**
   * Never throws — every call site fires this without awaiting from inside a
   * user-facing action (an invite accept, a blocked invite, a database
   * create), so a billing/mail hiccup here must never surface as, or block,
   * that action's own result.
   */
  async maybeFire(workspaceId: string, reason: SalesSignalReason): Promise<void> {
    try {
      await this.doFire(workspaceId, reason);
    } catch (error) {
      this.logger.warn(`sales-signal failed for ${workspaceId} (${reason}): ${String(error)}`);
    }
  }

  private async doFire(workspaceId: string, reason: SalesSignalReason): Promise<void> {
    const [claimed] = await this.db
      .update(workspaces)
      .set({ salesSignalSentAt: new Date(), salesSignalReason: reason })
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.salesSignalSentAt)))
      .returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
    if (!claimed) return; // already fired for this workspace, for whichever reason got there first

    // The flag/claim above is already committed at this point — a failure
    // from here on (caught by maybeFire's wrapper) loses the EMAIL, not the
    // admin-visible flag on AdminWorkspaceSummary, which still reflects the
    // real trigger. An accepted trade against re-sending, same as every other
    // best-effort notification producer in this codebase.
    const admins = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')),
    });
    if (admins.length === 0) return;
    const adminUsers = await this.db.query.user.findMany({ where: inArray(user.id, admins.map((m) => m.userId)) });
    if (adminUsers.length === 0) return;

    const billingUrl = `${env().WEB_URL.replace(/\/$/, '')}/w/${claimed.slug}/settings/billing`;
    for (const admin of adminUsers) {
      await this.email.send(
        { kind: 'sales-signal', to: admin.email, workspaceName: claimed.name, reason, billingUrl },
        workspaceId, // MN-194 — attributes this send's cost to the workspace it's about
      );
    }
  }
}
