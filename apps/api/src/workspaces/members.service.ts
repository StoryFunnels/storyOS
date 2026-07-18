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
import { memberships, user } from '../db/schema';
import type { MembershipRole } from '@storyos/schemas';
import { BillingService } from '../billing/billing.service';
import { EntitlementsService } from '../billing/entitlements.service';

/** admin/member are always billable; guest never is via role alone (grants decide — MN-121). */
const BILLABLE_ROLES: MembershipRole[] = ['admin', 'member'];

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
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
    if (BILLABLE_ROLES.includes(target.role)) {
      await this.billing.syncSeatQuantity(workspaceId).catch(() => undefined);
    }
    return { deleted: true };
  }
}
