import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { accessGrants, databases, memberships, records, spaces, views } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import type { Membership } from '../workspaces/workspace-access.guard';

/** ADR-0007: graded access. admin/member are workspace-wide fast paths. */
export type EffectiveRole =
  | 'viewer'
  | 'commenter'
  | 'contributor'
  | 'editor'
  | 'creator'
  | 'admin';
export type GrantRole = 'viewer' | 'commenter' | 'contributor' | 'editor' | 'creator';

/**
 * One graded ladder, not a matrix of capabilities (MN-121 — do NOT invent a second
 * mechanism). Each rung is a superset of the one below:
 *
 *   viewer      read
 *   commenter   + comment
 *   contributor + create/update records          ← no delete, no schema, no views
 *   editor      + delete records, views, links, buttons
 *   creator     + schema (fields, automations, rename)
 *   admin       everything, workspace-wide
 *
 * `contributor` exists so a client team can add work without being able to destroy
 * it, which was impossible while delete was welded to edit.
 */
export const ACCESS_RANK: Record<EffectiveRole, number> = {
  viewer: 0,
  commenter: 1,
  contributor: 2,
  editor: 3,
  creator: 4,
  admin: 5,
};

export interface GrantInput {
  space_id?: string;
  database_id?: string;
  /** #472 — third scope: one specific record. */
  record_id?: string;
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


  /**
   * #291 — is this personal space readable by this member?
   *
   * The ONE rule: a personal space belongs to its owner and to nobody else, admins
   * included (#290 decided no admin bypass, and the ADR's offboarding consequence
   * depends on it). Everything that lists or resolves spaces routes through here or
   * through `notOthersPersonal()` below, so the rule can't be forgotten at one
   * endpoint — which is how a privacy leak stays silent.
   */
  canSeePersonal(
    membership: Membership,
    space: { personal: boolean | null; ownerUserId: string | null },
  ): boolean {
    if (!space.personal) return true;
    return space.ownerUserId === membership.userId;
  }

  /**
   * #291 — SQL predicate for any query that lists spaces: keep shared spaces, plus
   * this member's OWN personal space. Compose it into an existing `and(...)`.
   */
  notOthersPersonal(membership: Membership) {
    return or(eq(spaces.personal, false), eq(spaces.ownerUserId, membership.userId));
  }

  /** #291 — same rule for views: shared views, plus this member's own personal ones. */
  notOthersPersonalView(membership: Membership) {
    return or(isNull(views.ownerUserId), eq(views.ownerUserId, membership.userId));
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

  /**
   * #472 — effective role for one RECORD: the max of a matching space grant, a
   * matching database grant (both via `effectiveForDatabase`) and a matching
   * RECORD grant — "highest grant wins" extended to the third scope, not a
   * separate rule. A guest with no space/database grant at all can still reach
   * a record they hold a direct record-scoped grant on; one who already has a
   * database grant is unaffected (their existing rank wins if it's higher).
   */
  async effectiveForRecord(
    membership: Membership,
    record: { id: string; databaseId: string; spaceId: string },
  ): Promise<EffectiveRole | null> {
    const fromDatabase = await this.effectiveForDatabase(membership, {
      id: record.databaseId,
      spaceId: record.spaceId,
    });
    if (membership.role !== 'guest') return fromDatabase;
    const grants = await this.guestGrants(membership);
    let best = fromDatabase;
    for (const grant of grants) {
      if (grant.recordId === record.id && (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best])) {
        best = grant.role;
      }
    }
    return best;
  }

  /**
   * Effective role for a SPACE (MN-124). null = no access (render as 404).
   *
   * Space delete had no per-scope check at all — only `@MinRole('member')` — so
   * there was nothing to ask. Mirrors effectiveForDatabase: admin → admin,
   * member → creator (a recorded decision: members are workspace-wide creators,
   * ADR-0009), guest → their grant on this space.
   */
  async effectiveForSpace(membership: Membership, spaceId: string): Promise<EffectiveRole | null> {
    // #291: check PERSONAL first. This used to return admin/creator without looking
    // at the space at all, which made every personal space readable by every member
    // and admin by construction.
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), notDeleted(spaces.deletedAt)),
      columns: { personal: true, ownerUserId: true },
    });
    if (space && !this.canSeePersonal(membership, space)) return null;
    if (membership.role === 'admin') return 'admin';
    if (membership.role === 'member') return 'creator';
    const grants = await this.guestGrants(membership);
    let best: EffectiveRole | null = null;
    for (const grant of grants) {
      if (grant.spaceId === spaceId && (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best])) {
        best = grant.role;
      }
    }
    return best;
  }

  /** Asserts a space role, 404-ing rather than leaking existence (MN-124). */
  async assertSpace(membership: Membership, spaceId: string, min: EffectiveRole) {
    const space = await this.db.query.spaces.findFirst({
      where: and(
        eq(spaces.id, spaceId),
        eq(spaces.workspaceId, membership.workspaceId),
        notDeleted(spaces.deletedAt),
      ),
    });
    if (!space) throw new NotFoundException('Space not found');
    const effective = await this.effectiveForSpace(membership, spaceId);
    this.assertRank(effective, min, 'Space');
    return space;
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
        where: and(inArray(databases.id, [...visibility.databaseIds]), notDeleted(databases.deletedAt)),
        columns: { spaceId: true },
      });
      rows.forEach((r) => result.add(r.spaceId));
    }
    return result;
  }

  /**
   * #469 — Databases a guest can see: directly granted + those inside a granted
   * space (mirrors `visibleSpaceIds`). null = sees every database (member/admin).
   *
   * This computation existed as three drifting copies before this ticket —
   * inline in `mentions.service.ts` `backlinks()`, again inline in
   * `search.controller.ts`, and nowhere at all in the two relation-chip readers
   * that leaked a guest's denied database's record titles. All three call sites
   * now go through this one.
   */
  async visibleDatabaseIds(membership: Membership): Promise<Set<string> | null> {
    const visibility = await this.guestVisibility(membership);
    if (!visibility) return null;
    const rows = await this.db.query.databases.findMany({
      where: and(eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
      columns: { id: true, spaceId: true },
    });
    return new Set(
      rows
        .filter((d) => visibility.spaceIds.has(d.spaceId) || visibility.databaseIds.has(d.id))
        .map((d) => d.id),
    );
  }

  assertRank(effective: EffectiveRole | null, min: EffectiveRole, what = 'resource') {
    if (effective === null) throw new NotFoundException(`${what} not found`);
    if (ACCESS_RANK[effective] < ACCESS_RANK[min]) {
      throw new ForbiddenException(`Requires ${min} access`);
    }
  }

  // --- Billing boundary (MN-121) ---

  /**
   * The ladder IS the billing boundary — no second concept (MN-121).
   *
   * Billable = can create anything: a member/admin (workspace-wide creators), or a
   * guest holding any grant at >= contributor on any scope. viewer/commenter-only
   * guests are free, which is what makes "viewers and guests are always free"
   * true rather than aspirational.
   *
   * Feeds MN-190 (seats), which cannot define a seat without this.
   */
  async isBillable(membership: Membership): Promise<boolean> {
    if (membership.role === 'admin' || membership.role === 'member') return true;
    const grants = await this.guestGrants(membership);
    return grants.some((g) => ACCESS_RANK[g.role] >= ACCESS_RANK.contributor);
  }

  /** Seat count for a workspace — the same predicate, evaluated in one pass. */
  async billableUserIds(workspaceId: string): Promise<string[]> {
    const members = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')),
    });
    const grants = await this.db.query.accessGrants.findMany({
      where: eq(accessGrants.workspaceId, workspaceId),
    });
    const canCreate = new Set(
      grants.filter((g) => ACCESS_RANK[g.role] >= ACCESS_RANK.contributor).map((g) => g.userId),
    );
    return members
      .filter((m) => m.role === 'admin' || m.role === 'member' || canCreate.has(m.userId))
      .map((m) => m.userId);
  }

  // --- Grants management (admin) ---

  private async validateScope(workspaceId: string, input: GrantInput) {
    const scopeCount = [input.space_id, input.database_id, input.record_id].filter(Boolean).length;
    if (scopeCount !== 1) {
      throw new UnprocessableEntityException('Provide exactly one of space_id / database_id / record_id');
    }
    if (input.space_id) {
      const space = await this.db.query.spaces.findFirst({
        where: and(eq(spaces.id, input.space_id), eq(spaces.workspaceId, workspaceId), notDeleted(spaces.deletedAt)),
      });
      if (!space) throw new NotFoundException('Space not found');
    }
    if (input.database_id) {
      const database = await this.db.query.databases.findFirst({
        where: and(
          eq(databases.id, input.database_id),
          eq(databases.workspaceId, workspaceId),
          notDeleted(databases.deletedAt),
        ),
      });
      if (!database) throw new NotFoundException('Database not found');
    }
    if (input.record_id) {
      // #472 — a record's workspace isn't denormalized onto the row, so this
      // joins through its (live) database the same way every other
      // record-scoped lookup in this codebase resolves workspace ownership.
      const [row] = await this.db
        .select({ id: records.id })
        .from(records)
        .innerJoin(databases, eq(databases.id, records.databaseId))
        .where(
          and(
            eq(records.id, input.record_id),
            eq(databases.workspaceId, workspaceId),
            isNull(records.deletedAt),
            notDeleted(databases.deletedAt),
          ),
        );
      if (!row) throw new NotFoundException('Record not found');
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
        record_id: g.recordId,
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

    /**
     * MN-125: a real atomic upsert. This was read-then-write with no unique index
     * behind it, so two concurrent grants on the same scope produced duplicate
     * rows — reads took a max and failed safe, but revoke then removed only one
     * of them and reported success while access silently persisted.
     */
    const upsertTarget = input.space_id
      ? [accessGrants.userId, accessGrants.spaceId]
      : input.database_id
        ? [accessGrants.userId, accessGrants.databaseId]
        : [accessGrants.userId, accessGrants.recordId];
    const upsertTargetWhere = input.space_id
      ? sql`${accessGrants.spaceId} IS NOT NULL`
      : input.database_id
        ? sql`${accessGrants.databaseId} IS NOT NULL`
        : sql`${accessGrants.recordId} IS NOT NULL`;
    const [row] = await this.db
      .insert(accessGrants)
      .values({
        workspaceId,
        userId: input.user_id,
        spaceId: input.space_id,
        databaseId: input.database_id,
        recordId: input.record_id,
        role: input.role,
        createdBy,
      })
      .onConflictDoUpdate({
        target: upsertTarget,
        targetWhere: upsertTargetWhere,
        set: { role: input.role, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async createGrants(workspaceId: string, userId: string, grants: GrantInput[], createdBy: string) {
    for (const grant of grants) {
      await this.createGrant(workspaceId, { ...grant, user_id: userId }, createdBy);
    }
  }

  /**
   * MN-125: revoke means revoke. Deleting by id alone left any duplicate row for
   * the same (user, scope) in place, so access survived a "successful" revoke.
   * The unique indexes make duplicates impossible going forward; this clears any
   * that predate them, so the fix is not conditional on the migration having run.
   */
  async deleteGrant(workspaceId: string, grantId: string) {
    const grant = await this.db.query.accessGrants.findFirst({
      where: and(eq(accessGrants.id, grantId), eq(accessGrants.workspaceId, workspaceId)),
    });
    if (!grant) throw new NotFoundException('Grant not found');

    const sameScope = grant.spaceId
      ? eq(accessGrants.spaceId, grant.spaceId)
      : grant.databaseId
        ? eq(accessGrants.databaseId, grant.databaseId)
        : eq(accessGrants.recordId, grant.recordId!);
    const gone = await this.db
      .delete(accessGrants)
      .where(
        and(
          eq(accessGrants.workspaceId, workspaceId),
          eq(accessGrants.userId, grant.userId),
          sameScope,
        ),
      )
      .returning({ id: accessGrants.id });
    return { deleted: true, removed: gone.length };
  }
}
