import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { accessGrants, databases, memberships, spaces } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';

/** ADR-0007: graded access. admin/member are workspace-wide fast paths. */
export type EffectiveRole = 'viewer' | 'commenter' | 'editor' | 'creator' | 'admin';
export type GrantRole = 'viewer' | 'commenter' | 'editor' | 'creator';

export const ACCESS_RANK: Record<EffectiveRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  creator: 3,
  admin: 4,
};

export interface GrantInput {
  space_id?: string;
  database_id?: string;
  role: GrantRole;
}

@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async guestGrants(membership: Membership) {
    return this.db.query.accessGrants.findMany({
      where: and(
        eq(accessGrants.workspaceId, membership.workspaceId),
        eq(accessGrants.userId, membership.userId),
      ),
    });
  }

  /** Effective role for one database. null = no access (render as 404). */
  async effectiveForDatabase(
    membership: Membership,
    database: { id: string; spaceId: string },
  ): Promise<EffectiveRole | null> {
    if (membership.role === 'admin') return 'admin';
    if (membership.role === 'member') return 'creator';
    const grants = await this.guestGrants(membership);
    let best: EffectiveRole | null = null;
    for (const grant of grants) {
      if (grant.databaseId === database.id || grant.spaceId === database.spaceId) {
        if (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best]) best = grant.role;
      }
    }
    return best;
  }

  /** For list filtering. null = sees everything (admin/member). */
  async guestVisibility(
    membership: Membership,
  ): Promise<{ spaceIds: Set<string>; databaseIds: Set<string> } | null> {
    if (membership.role !== 'guest') return null;
    const grants = await this.guestGrants(membership);
    const spaceIds = new Set(grants.map((g) => g.spaceId).filter((v): v is string => Boolean(v)));
    const databaseIds = new Set(
      grants.map((g) => g.databaseId).filter((v): v is string => Boolean(v)),
    );
    return { spaceIds, databaseIds };
  }

  /** Spaces a guest can see: directly granted + those containing granted databases. */
  async visibleSpaceIds(membership: Membership): Promise<Set<string> | null> {
    const visibility = await this.guestVisibility(membership);
    if (!visibility) return null;
    const result = new Set(visibility.spaceIds);
    if (visibility.databaseIds.size > 0) {
      const rows = await this.db.query.databases.findMany({
        where: inArray(databases.id, [...visibility.databaseIds]),
        columns: { spaceId: true },
      });
      rows.forEach((r) => result.add(r.spaceId));
    }
    return result;
  }

  assertRank(effective: EffectiveRole | null, min: EffectiveRole, what = 'resource') {
    if (effective === null) throw new NotFoundException(`${what} not found`);
    if (ACCESS_RANK[effective] < ACCESS_RANK[min]) {
      throw new ForbiddenException(`Requires ${min} access`);
    }
  }

  // --- Grants management (admin) ---

  private async validateScope(workspaceId: string, input: GrantInput) {
    const hasSpace = Boolean(input.space_id);
    const hasDb = Boolean(input.database_id);
    if (hasSpace === hasDb) {
      throw new UnprocessableEntityException('Provide exactly one of space_id / database_id');
    }
    if (input.space_id) {
      const space = await this.db.query.spaces.findFirst({
        where: and(eq(spaces.id, input.space_id), eq(spaces.workspaceId, workspaceId)),
      });
      if (!space) throw new NotFoundException('Space not found');
    }
    if (input.database_id) {
      const database = await this.db.query.databases.findFirst({
        where: and(eq(databases.id, input.database_id), eq(databases.workspaceId, workspaceId)),
      });
      if (!database) throw new NotFoundException('Database not found');
    }
  }

  async listGrants(workspaceId: string, userId?: string) {
    const rows = await this.db.query.accessGrants.findMany({
      where: userId
        ? and(eq(accessGrants.workspaceId, workspaceId), eq(accessGrants.userId, userId))
        : eq(accessGrants.workspaceId, workspaceId),
    });
    return {
      data: rows.map((g) => ({
        id: g.id,
        user_id: g.userId,
        space_id: g.spaceId,
        database_id: g.databaseId,
        role: g.role,
      })),
    };
  }

  /** Upsert: one grant per (user, scope) — a new role replaces the old one. */
  async createGrant(workspaceId: string, input: GrantInput & { user_id: string }, createdBy: string) {
    await this.validateScope(workspaceId, input);
    const target = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, input.user_id),
      ),
    });
    if (!target) throw new NotFoundException('That person is not in this workspace');

    const existing = await this.db.query.accessGrants.findMany({
      where: and(
        eq(accessGrants.workspaceId, workspaceId),
        eq(accessGrants.userId, input.user_id),
      ),
    });
    const duplicate = existing.find(
      (g) =>
        (input.space_id && g.spaceId === input.space_id) ||
        (input.database_id && g.databaseId === input.database_id),
    );
    if (duplicate) {
      const [updated] = await this.db
        .update(accessGrants)
        .set({ role: input.role })
        .where(eq(accessGrants.id, duplicate.id))
        .returning();
      return updated!;
    }
    const [created] = await this.db
      .insert(accessGrants)
      .values({
        workspaceId,
        userId: input.user_id,
        spaceId: input.space_id,
        databaseId: input.database_id,
        role: input.role,
        createdBy,
      })
      .returning();
    return created!;
  }

  async createGrants(workspaceId: string, userId: string, grants: GrantInput[], createdBy: string) {
    for (const grant of grants) {
      await this.createGrant(workspaceId, { ...grant, user_id: userId }, createdBy);
    }
  }

  async deleteGrant(workspaceId: string, grantId: string) {
    const [gone] = await this.db
      .delete(accessGrants)
      .where(and(eq(accessGrants.id, grantId), eq(accessGrants.workspaceId, workspaceId)))
      .returning();
    if (!gone) throw new NotFoundException('Grant not found');
    return { deleted: true };
  }
}
