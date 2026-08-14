import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, spaces, user, views } from '../db/schema';
import type { MembershipRole } from '@storyos/schemas';
import { BillingService } from '../billing/billing.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { MembershipEventsService } from '../events/membership-events.service';

/** admin/member are always billable; guest never is via role alone (grants decide — MN-121). */
const BILLABLE_ROLES: MembershipRole[] = ['admin', 'member'];

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly membershipEvents: MembershipEventsService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')),
    });
    if (rows.length === 0) return [];
    const users = await this.db.query.user.findMany({
      where: inArray(
        user.id,
        rows.map((m) => m.userId),
      ),
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => ({
      id: m.id,
      role: m.role,
      user_id: m.userId,
      user: {
        id: m.userId,
        name: byId.get(m.userId)?.name ?? '(deactivated)',
        email: byId.get(m.userId)?.email ?? null,
        image: byId.get(m.userId)?.image ?? null,
      },
    }));
  }

  private async assertNotLastAdmin(workspaceId: string, membershipId: string) {
    const admins = await this.db.query.memberships.findMany({
      where: and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'admin'),
        eq(memberships.status, 'active'),
      ),
    });
    if (admins.length === 1 && admins[0]!.id === membershipId) {
      throw new ConflictException('Cannot remove or demote the last admin');
    }
  }

  async update(
    workspaceId: string,
    membershipId: string,
    patch: { role?: MembershipRole },
  ) {
    const target = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)),
    });
    if (!target) throw new NotFoundException('Member not found');

    if (patch.role && patch.role !== 'admin' && target.role === 'admin') {
      await this.assertNotLastAdmin(workspaceId, membershipId);
    }

    // MN-190: a guest promoted to member/admin newly consumes a seat. A
    // demotion (member/admin -> guest) never needs the check — it can only
    // free a seat, not claim one — and role changes within the billable set
    // (admin <-> member) don't change the count either.
    const becomingBillable =
      patch.role && !BILLABLE_ROLES.includes(target.role) && BILLABLE_ROLES.includes(patch.role);
    if (becomingBillable && !(await this.entitlements.can(workspaceId, 'add_seat'))) {
      throw new HttpException(
        'Free plan is limited to 2 members — upgrade to Pro to promote another one.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const [updated] = await this.db
      .update(memberships)
      .set({ role: patch.role ?? target.role })
      .where(eq(memberships.id, membershipId))
      .returning();

    if (patch.role && patch.role !== target.role) {
      await this.billing.syncSeatQuantity(workspaceId).catch(() => undefined);
      // #128: a role change re-projects the Member's row (new Role, still
      // active). No-op for the projection when the role didn't actually change.
      this.membershipEvents.emit({
        type: 'membership_changed',
        workspaceId,
        userId: target.userId,
      });
    }
    return updated!;
  }

  async remove(workspaceId: string, membershipId: string) {
    const target = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)),
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'admin') await this.assertNotLastAdmin(workspaceId, membershipId);

    await this.db.delete(memberships).where(eq(memberships.id, membershipId));

    /**
     * #291/#290 — HARD-DELETE this member's personal content.
     *
     * The ADR promises a departing member's personal docs are gone, with no
     * break-glass path. Leaving the rows behind while merely hiding them would be
     * the worst outcome: the privacy promise broken AND the content unreachable.
     *
     * Scope is deliberately narrow and is the load-bearing part: the personal SPACE
     * (its space_documents and space_folders cascade from it) and this member's
     * personal VIEWS. Never records, never databases — a personal view is a saved
     * query over SHARED data, so deleting it must not touch a single record that a
     * private board happened to point at.
     */
    await this.db
      .delete(views)
      .where(eq(views.ownerUserId, target.userId));
    await this.db
      .delete(spaces)
      .where(
        and(
          eq(spaces.workspaceId, workspaceId),
          eq(spaces.personal, true),
          eq(spaces.ownerUserId, target.userId),
        ),
      );

    if (BILLABLE_ROLES.includes(target.role)) {
      await this.billing.syncSeatQuantity(workspaceId).catch(() => undefined);
    }

    // #128: removal TOMBSTONES the Member row (marks it inactive), it does not
    // delete it — records assigned to this person must keep a resolvable Member.
    this.membershipEvents.emit({
      type: 'membership_removed',
      workspaceId,
      userId: target.userId,
    });

    return { deleted: true };
  }
}
