import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, user } from '../db/schema';
import type { MembershipRole } from '@storyos/schemas';

@Injectable()
export class MembersService {
  constructor(@Inject(DB) private readonly db: Db) {}

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
      space_ids: m.spaceIds,
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
    patch: { role?: MembershipRole; space_ids?: string[] },
  ) {
    const target = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)),
    });
    if (!target) throw new NotFoundException('Member not found');

    if (patch.role && patch.role !== 'admin' && target.role === 'admin') {
      await this.assertNotLastAdmin(workspaceId, membershipId);
    }

    const spaceIds =
      (patch.role ?? target.role) === 'guest' ? (patch.space_ids ?? target.spaceIds) : null;

    const [updated] = await this.db
      .update(memberships)
      .set({ role: patch.role ?? target.role, spaceIds })
      .where(eq(memberships.id, membershipId))
      .returning();
    return updated!;
  }

  async remove(workspaceId: string, membershipId: string) {
    const target = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)),
    });
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === 'admin') await this.assertNotLastAdmin(workspaceId, membershipId);

    await this.db.delete(memberships).where(eq(memberships.id, membershipId));
    return { deleted: true };
  }
}
