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
import { BOUNDARY_REFUSAL } from './resource-scope';
import { forgetForRequest, memoizeForRequest } from './request-memo';

/** Ticket #1173 — the one sentence every refusal to place a database in a personal space carries. */
export const PERSONAL_SPACE_HOLDS_NO_DATABASES =
  'A personal space holds documents and views only, so a database cannot live there.';

/** Ticket #1173 — the predicate: only a space whose `personal` flag is off can hold a database. Never the name. */
export function spaceCanHoldDatabases(space: { personal: boolean | null }): boolean {
  return !space.personal;
}

/** Ticket #1173 — the pure refusal, for callers with no AccessService (the Architect, the integration mirrors). 422. */
export function assertSpaceCanHoldDatabases(space: { personal: boolean | null }): void {
  if (!spaceCanHoldDatabases(space)) throw new UnprocessableEntityException(PERSONAL_SPACE_HOLDS_NO_DATABASES);
}

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

  /**
   * #943 / ADR-0018 — the RESTRICTED spaces and databases of this workspace, once per request (memoized like the grants, and
   * dropped by every grant/flag write). null when nothing is restricted, which is the case for every workspace that has not
   * used the feature: the whole model then collapses to today's behaviour at the cost of ONE small query.
   *
   * Only read for a non-admin: an admin sees everything, so it never asks.
   */
  private closedResources(membership: Membership) {
    return memoizeForRequest(`closed:${membership.workspaceId}`, async () => {
      // Internal callers act with a role-less `{ workspaceId }` membership (members-db provisioning): they are neither a member
      // nor a guest and have always seen everything, so nothing is closed to them.
      if (membership.role !== 'member' && membership.role !== 'guest') return null;
      const res = (await this.db.execute(sql`
        SELECT 's' AS kind, id FROM spaces WHERE workspace_id = ${membership.workspaceId} AND restricted AND deleted_at IS NULL
        UNION ALL
        SELECT 'd' AS kind, id FROM databases WHERE workspace_id = ${membership.workspaceId} AND restricted AND deleted_at IS NULL`)) as unknown as {
        rows?: Array<{ kind: 's' | 'd'; id: string }>;
      };
      const rows = res.rows ?? [];
      if (rows.length === 0) return null;
      return {
        spaces: new Set(rows.filter((r) => r.kind === 's').map((r) => r.id)),
        databases: new Set(rows.filter((r) => r.kind === 'd').map((r) => r.id)),
      };
    });
  }

  /**
   * ADR-0018 — is anything closed to THIS caller? An admin: never. A guest: always (everything is closed to a guest unless a
   * grant opens it). A member: only in a workspace that has restricted something. The one predicate that replaces the literal
   * `role === 'guest'` branches, so a restricted member is narrowed by the same code a guest is.
   */
  async isNarrowed(membership: Membership): Promise<boolean> {
    if (membership.role === 'admin') return false;
    if (membership.role === 'guest') return true;
    return (await this.closedResources(membership)) !== null;
  }

  /**
   * The one resolver for "what does THIS caller hold on this database". admin: admin. A member where the database and its space
   * are both open: creator (today's behaviour). Otherwise the best of the caller's grants, where STICKY restriction (ADR-0018 §3)
   * means a database that is itself restricted is opened only by a grant ON the database, never by a grant on its space.
   * A guest is the same function with "open" never true.
   */
  private async resolveDatabaseRole(
    membership: Membership,
    database: { id: string; spaceId: string },
    grants?: Array<typeof accessGrants.$inferSelect>,
    closed?: Awaited<ReturnType<AccessService['closedResources']>>,
  ): Promise<EffectiveRole | null> {
    if (membership.role === 'admin') return 'admin';
    const closedNow = closed === undefined ? await this.closedResources(membership) : closed;
    if (membership.role !== 'guest' && (!closedNow || (!closedNow.databases.has(database.id) && !closedNow.spaces.has(database.spaceId)))) {
      return 'creator';
    }
    const held = grants ?? (await this.guestGrants(membership));
    const sticky = closedNow?.databases.has(database.id) ?? false;
    let best: EffectiveRole | null = null;
    for (const grant of held) {
      if (grant.databaseId === database.id || (!sticky && grant.spaceId === database.spaceId)) {
        if (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best]) best = grant.role;
      }
    }
    return best;
  }

  /**
   * #880 — is this database closed to some members: restricted itself, or inside a restricted space? For a channel we do not
   * control the membership of (the Slack mirror), "open to every member" is the only safe thing to post to.
   */
  async isClosedToSomeMembers(workspaceId: string, databaseId: string): Promise<boolean> {
    const res = (await this.db.execute(sql`
      SELECT 1 FROM databases d JOIN spaces s ON s.id = d.space_id
      WHERE d.id = ${databaseId} AND d.workspace_id = ${workspaceId} AND (d.restricted OR s.restricted) LIMIT 1`)) as unknown as { rows?: unknown[] };
    return (res.rows?.length ?? 0) > 0;
  }

  /** Drop this request's memo of the restricted set: call it after any write to `spaces.restricted` / `databases.restricted`. */
  forgetClosed(): void {
    forgetForRequest('closed:');
  }

  /**
   * #861 — read once per REQUEST (see `request-memo.ts`: the memo cannot outlive the request, and
   * `createGrant`/`deleteGrant` drop it). Never cache this any wider: MN-125.
   */
  private guestGrants(membership: Membership) {
    const ceiling = membership.bound;
    return memoizeForRequest(
      `grants:${membership.workspaceId}:${membership.userId}${ceiling ? ':bound' : ''}`,
      () => (ceiling ? this.boundTokenGrants(membership, ceiling) : this.realGuestGrants(membership)),
    );
  }

  private realGuestGrants(membership: Membership) {
    return this.db.query.accessGrants.findMany({
      where: and(
        eq(accessGrants.workspaceId, membership.workspaceId),
        eq(accessGrants.userId, membership.userId),
      ),
    });
  }

  /**
   * #543 — the grants a token bound to specific spaces/databases acts with: ONE grant per listed
   * entry, at the rank its owner really holds there, so a bound token is by construction never
   * wider than its owner and every guest narrowing already in this file applies to it unchanged.
   *
   *   admin / member owner → 'creator' on each listed entry (admin is capped to creator: a bound
   *                          token never gets workspace-admin rank, which is least privilege)
   *   guest owner          → the owner's own best grant on that entry; an entry they cannot
   *                          reach drops out, so narrowing the owner narrows the token live.
   *
   * Computed per request from the live rows, never snapshotted: deleting a listed space or
   * database, or revoking the owner's grant, takes effect on the next call. Another member's
   * personal space is dropped even if listed (#291).
   */
  private async boundTokenGrants(
    membership: Membership,
    ceiling: NonNullable<Membership['bound']>,
  ): Promise<Array<typeof accessGrants.$inferSelect>> {
    const [spaceRows, databaseRows] = await Promise.all([
      ceiling.spaceIds.length
        ? this.db.query.spaces.findMany({
            where: and(
              inArray(spaces.id, ceiling.spaceIds),
              eq(spaces.workspaceId, membership.workspaceId),
              notDeleted(spaces.deletedAt),
            ),
          })
        : [],
      ceiling.databaseIds.length
        ? this.db.query.databases.findMany({
            where: and(
              inArray(databases.id, ceiling.databaseIds),
              eq(databases.workspaceId, membership.workspaceId),
              notDeleted(databases.deletedAt),
            ),
          })
        : [],
    ]);
    const visibleSpaces = spaceRows.filter((s) => this.canSeePersonal(membership, s));
    const ownerGrants = ceiling.realRole === 'guest' ? await this.realGuestGrants(membership) : [];
    const rank = (r: GrantRole | null) => (r ? ACCESS_RANK[r] : -1);
    const bestOf = (matches: (g: (typeof ownerGrants)[number]) => boolean): GrantRole | null => {
      let best: GrantRole | null = null;
      for (const g of ownerGrants) if (matches(g) && rank(g.role) > rank(best)) best = g.role;
      return best;
    };
    // #943 — a MEMBER owner's ceiling is what that member can really reach, capped at creator: a member holds 'creator' on
    // everything that is not restricted and only their grant on what is. Resolved against the owner as a plain member (not the
    // bound, downgraded view of them), so a token bound to a restricted entry its owner cannot read gets NOTHING for it.
    const realMember = { ...membership, role: 'member' as const, bound: undefined };
    const cap = (role: EffectiveRole | null): GrantRole | null => (role === null ? null : role === 'admin' ? 'creator' : role);
    const now = new Date();
    const grant = (scope: { spaceId?: string; databaseId?: string }, role: GrantRole) =>
      ({
        id: `bound:${scope.spaceId ?? scope.databaseId}`,
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        spaceId: scope.spaceId ?? null,
        databaseId: scope.databaseId ?? null,
        recordId: null,
        role,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      }) as typeof accessGrants.$inferSelect;
    const out: Array<typeof accessGrants.$inferSelect> = [];
    for (const space of visibleSpaces) {
      const role =
        ceiling.realRole === 'guest'
          ? bestOf((g) => g.spaceId === space.id)
          : ceiling.realRole === 'admin'
            ? 'creator'
            : cap(await this.effectiveForSpace(realMember, space.id));
      if (role) out.push(grant({ spaceId: space.id }, role));
    }
    // #943 — a RESTRICTED database inside a bound space. A space grant never opens a restricted database (the restriction is
    // sticky: only a grant on the database itself does), so the space-level entry above cannot reach it for the token either. The
    // token's reach there is the owner's real reach, capped at creator, exactly as for a database named in the binding: a member
    // with a direct grant gets that grant's role, one without gets nothing, an admin gets creator. Without this a token bound to a
    // space could never see a restricted database its owner is entitled to, whatever the owner was granted.
    const covered = new Set(databaseRows.map((d) => d.id));
    const restrictedInside = visibleSpaces.length
      ? await this.db.query.databases.findMany({
          where: and(
            inArray(databases.spaceId, visibleSpaces.map((sp) => sp.id)),
            eq(databases.restricted, true),
            notDeleted(databases.deletedAt),
          ),
        })
      : [];
    for (const database of restrictedInside) {
      if (covered.has(database.id)) continue;
      const role =
        ceiling.realRole === 'guest'
          ? bestOf((g) => g.databaseId === database.id)
          : ceiling.realRole === 'admin'
            ? 'creator'
            : cap(await this.resolveDatabaseRole(realMember, database));
      if (role) out.push(grant({ databaseId: database.id }, role));
    }
    for (const database of databaseRows) {
      const role =
        ceiling.realRole === 'guest'
          ? bestOf((g) => g.databaseId === database.id || g.spaceId === database.spaceId)
          : ceiling.realRole === 'admin'
            ? 'creator'
            : cap(await this.resolveDatabaseRole(realMember, database));
      if (role) out.push(grant({ databaseId: database.id }, role));
    }
    return out;
  }

  /**
   * #845 — a guest's grants reduced to the three id sets a record can be matched against
   * (a record is readable if its id, its database, or its space is in the matching set —
   * the same three-way max `effectiveForRecords` computes in memory, expressed as data so a
   * caller can push it into SQL). null for admin/member: no narrowing applies.
   */
  async guestScopeIds(
    membership: Membership,
  ): Promise<{ spaceIds: string[]; databaseIds: string[]; recordIds: string[] } | null> {
    if (membership.role === 'admin') return null;
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && !closed) return null;
    const grants = await this.guestGrants(membership);
    const ids = (pick: (g: (typeof grants)[number]) => string | null) =>
      [...new Set(grants.map(pick).filter((id): id is string => Boolean(id)))];
    if (!closed) {
      return { spaceIds: ids((g) => g.spaceId), databaseIds: ids((g) => g.databaseId), recordIds: ids((g) => g.recordId) };
    }
    // Something is restricted: a space grant no longer means "every database in the space" (sticky restriction), and a member
    // sees everything that is open, which an allow-list of grants cannot say. Express it as an explicit list of databases.
    const visible = await this.visibleDatabaseIds(membership);
    return { spaceIds: [], databaseIds: [...(visible ?? [])], recordIds: ids((g) => g.recordId) };
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
    return this.resolveDatabaseRole(membership, database);
  }

  /**
   * #562 — `effectiveForDatabase`, batched across many databases in ONE grants
   * fetch rather than one per row: `DatabasesService.list()` needs `my_access`
   * per row for a write-access-only picker, and calling `effectiveForDatabase`
   * per database would re-run `guestGrants`'s own DB query once per row for
   * every guest viewer of the list. admin/member never touch the grants table
   * at all (same workspace-wide fast path `effectiveForDatabase` takes), so
   * the batching only matters for guests — but it's correct for every role.
   */
  async effectiveForDatabases(
    membership: Membership,
    databaseRows: ReadonlyArray<{ id: string; spaceId: string }>,
  ): Promise<Map<string, EffectiveRole | null>> {
    if (membership.role === 'admin') return new Map(databaseRows.map((d) => [d.id, 'admin' as const]));
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && !closed) return new Map(databaseRows.map((d) => [d.id, 'creator' as const]));
    const grants = await this.guestGrants(membership);
    const out = new Map<string, EffectiveRole | null>();
    for (const d of databaseRows) out.set(d.id, await this.resolveDatabaseRole(membership, d, grants, closed));
    return out;
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
    // A record grant can only ADD (highest wins), so an admin, and a member on an open database, already hold the top rung.
    if (membership.role === 'admin' || (membership.role !== 'guest' && fromDatabase === 'creator')) return fromDatabase;
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
   * #674 — `effectiveForRecord`, batched across many records (possibly
   * spanning many DIFFERENT databases) in ONE grants fetch, the same
   * relationship `effectiveForDatabases` already has to `effectiveForDatabase`.
   * Needed for hierarchy activity aggregation, which walks a relation tree
   * that can cross database boundaries (Epic → Story → Task) and must not
   * issue one grants query per record reached.
   *
   * Replicates `effectiveForRecord`'s exact three-way max (space grant,
   * database grant, record grant) — admin/member short-circuit exactly as
   * every other `effectiveFor*` does; only the guest path fetches grants,
   * once, then resolves every record against that one list in memory.
   */
  async effectiveForRecords(
    membership: Membership,
    recordRows: ReadonlyArray<{ id: string; databaseId: string; spaceId: string }>,
  ): Promise<Map<string, EffectiveRole | null>> {
    if (membership.role === 'admin') return new Map(recordRows.map((r) => [r.id, 'admin' as const]));
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && !closed) return new Map(recordRows.map((r) => [r.id, 'creator' as const]));
    const grants = await this.guestGrants(membership);
    const out = new Map<string, EffectiveRole | null>();
    for (const r of recordRows) {
      let best = await this.resolveDatabaseRole(membership, { id: r.databaseId, spaceId: r.spaceId }, grants, closed);
      for (const grant of grants) {
        if (grant.recordId === r.id && (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best])) best = grant.role;
      }
      out.set(r.id, best);
    }
    return out;
  }

  /**
   * #474 — the record-level counterpart to `guestVisibility`: does this guest
   * have any reason to be inside this DATABASE at all, even with NO space or
   * database grant? A record-scoped grant (#472) alone must not 404 the
   * whole database (that would make a record grant unreachable through any
   * list/query surface, only through a direct `GET /records/:rec` the guest
   * already happens to have the id for) — but it must not unlock the whole
   * database either. Two separate callers use this for two separate jobs:
   * the ENTRY gate (`DatabasesService.assertAccess`, via `bestRole` — "is
   * `min` satisfied at all") and the DATA narrowing (`RecordsService`'s
   * list/query paths, via `ids` — "which rows may actually come back").
   *
   * null = no record-level narrowing needed — admin/member, or a guest who
   * already holds a space/database grant here (today's unchanged behavior:
   * they see every record, same as before this method existed).
   *
   * A non-null result with an EMPTY `ids` set means the guest has no grant
   * reaching this database at all (record, database, or space) — callers
   * must treat that as "matches nothing," not "no restriction."
   */
  async visibleRecordIds(
    membership: Membership,
    database: { id: string; spaceId: string },
  ): Promise<{ ids: Set<string>; bestRole: GrantRole | null } | null> {
    if (membership.role === 'admin') return null;
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && (!closed || (!closed.databases.has(database.id) && !closed.spaces.has(database.spaceId)))) {
      return null; // an open database: no record-level narrowing
    }
    const grants = await this.guestGrants(membership);
    const sticky = closed?.databases.has(database.id) ?? false;
    const hasBroaderGrant = grants.some((g) => g.databaseId === database.id || (!sticky && g.spaceId === database.spaceId));
    if (hasBroaderGrant) return null;
    const recordGrants = grants.filter(
      (g): g is typeof g & { recordId: string } => Boolean(g.recordId),
    );
    if (recordGrants.length === 0) return { ids: new Set(), bestRole: null };
    // A grant's recordId has no databaseId of its own (schema.ts:200-206's
    // three scopes are mutually exclusive columns) — resolve which of this
    // caller's record grants actually belong to THIS database.
    const rows = await this.db.query.records.findMany({
      where: and(
        inArray(
          records.id,
          recordGrants.map((g) => g.recordId),
        ),
        eq(records.databaseId, database.id),
        notDeleted(records.deletedAt),
      ),
      columns: { id: true },
    });
    const ids = new Set(rows.map((r) => r.id));
    let bestRole: GrantRole | null = null;
    for (const g of recordGrants) {
      if (!ids.has(g.recordId)) continue;
      if (!bestRole || ACCESS_RANK[g.role] > ACCESS_RANK[bestRole]) bestRole = g.role;
    }
    return { ids, bestRole };
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
    if (membership.role !== 'guest') {
      const closed = await this.closedResources(membership);
      if (!closed?.spaces.has(spaceId)) return 'creator'; // ADR-0018: only a RESTRICTED space is closed to a member
    }
    const grants = await this.guestGrants(membership);
    let best: EffectiveRole | null = null;
    for (const grant of grants) {
      if (grant.spaceId === spaceId && (!best || ACCESS_RANK[grant.role] > ACCESS_RANK[best])) {
        best = grant.role;
      }
    }
    return best;
  }

  /**
   * #543 — the gate EVERY by-id path for a bound token must pass first: if the database named in
   * the URL is not reachable, refuse in words BEFORE looking up the record / view / comment under
   * it, so the answer is the same whether or not that child exists. A no-op for everyone else.
   */
  async assertBoundDatabaseReach(membership: Membership, databaseId: string): Promise<void> {
    if (!membership.bound) return;
    const database = await this.db.query.databases.findFirst({
      where: and(
        eq(databases.id, databaseId),
        eq(databases.workspaceId, membership.workspaceId),
        notDeleted(databases.deletedAt),
      ),
      columns: { id: true, spaceId: true },
    });
    if (!database || (await this.effectiveForDatabase(membership, database)) === null) {
      throw new ForbiddenException(BOUNDARY_REFUSAL);
    }
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
    if (!space) {
      if (membership.bound) throw new ForbiddenException(BOUNDARY_REFUSAL);
      throw new NotFoundException('Space not found');
    }
    const effective = await this.effectiveForSpace(membership, spaceId);
    if (effective === null && membership.bound) throw new ForbiddenException(BOUNDARY_REFUSAL);
    this.assertRank(effective, min, 'Space');
    return space;
  }

  /**
   * Ticket #1173 — THE rule for where a database may live: never in a PERSONAL space (personal-space.md §2: documents and views only,
   * since a private database is a private schema). Keyed on the `personal` flag, never the name. Every path that places a database —
   * create, move, template, pack install, duplicate, the Architect, the integration mirrors — goes through one of these three, so the
   * rule cannot drift per surface. A database already sitting in one (a pre-#1173 move) is not touched here; this only stops new ones.
   */
  spaceCanHoldDatabases(space: { personal: boolean | null }): boolean {
    return spaceCanHoldDatabases(space);
  }

  /** The pure half: refuse (422) a space row that is personal. Call it AFTER the visibility check, so the refusal never confirms a space exists. */
  assertSpaceCanHoldDatabases(space: { personal: boolean | null }): void {
    assertSpaceCanHoldDatabases(space);
  }

  /**
   * The whole check for a destination: `assertSpace` first (another member's personal space, a missing, trashed or other-workspace one
   * are all the same 404, ADR-0018 b), THEN refuse a personal space the caller does own. Returns the space row.
   */
  async assertDatabaseHome(membership: Membership, spaceId: string, min: EffectiveRole) {
    const space = await this.assertSpace(membership, spaceId, min);
    this.assertSpaceCanHoldDatabases(space);
    return space;
  }

  /**
   * #940 — the sidebar DOOR for a space: the space exists in this workspace, it is not someone else's personal space, and
   * (for a guest) it is one the guest can see at all. 404 in every refusal, so the answer never says which.
   *
   * The door is `visibleSpaceIds`, NOT `assertSpace`: `assertSpace` → `effectiveForSpace` matches only SPACE-scoped grants,
   * but a guest holding a database grant sees the parent space in their sidebar (`visibleSpaceIds` adds it), and
   * `assertSpace` would 404 a space the product just showed them (views-and-the-sidebar.md). This was inline in
   * `SpaceViewsService.assertVisibleSpace`, and folders had no check at all; one function so the two cannot drift.
   */
  async assertSpaceDoor(membership: Membership, spaceId: string) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, membership.workspaceId), notDeleted(spaces.deletedAt)),
      columns: { id: true, personal: true, ownerUserId: true },
    });
    if (!space) throw new NotFoundException('Space not found');
    if (!this.canSeePersonal(membership, space)) throw new NotFoundException('Space not found');
    const visible = await this.visibleSpaceIds(membership);
    if (visible !== null && !visible.has(spaceId)) throw new NotFoundException('Space not found');
    return space;
  }

  /**
   * The GRANTS a guest holds, as space and database id sets. null for admin/member: it says "no grant-based narrowing", which is
   * NOT the same as "sees everything" once something is restricted. Resolved visibility is `visibleSpaceIds` /
   * `visibleDatabaseIds` below; this stays as the raw grant view for the callers that only need to know a guest holds anything.
   */
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

  /**
   * Spaces this caller can see in the sidebar (ADR-0018). A guest: spaces they hold a grant on, plus the parent of every database
   * they hold a grant on. A member: every space that is not restricted, plus the same two. null = admin, or a member in a workspace
   * that restricts nothing: no narrowing.
   */
  async visibleSpaceIds(membership: Membership): Promise<Set<string> | null> {
    if (membership.role === 'admin') return null;
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && !closed) return null;
    const grants = await this.guestGrants(membership);
    const result = new Set(grants.map((g) => g.spaceId).filter((v): v is string => Boolean(v)));
    const grantedDatabases = grants.map((g) => g.databaseId).filter((v): v is string => Boolean(v));
    if (grantedDatabases.length > 0) {
      const rows = await this.db.query.databases.findMany({
        where: and(inArray(databases.id, grantedDatabases), notDeleted(databases.deletedAt)),
        columns: { spaceId: true },
      });
      rows.forEach((r) => result.add(r.spaceId));
    }
    if (membership.role !== 'guest') {
      const all = await this.db.query.spaces.findMany({
        where: and(eq(spaces.workspaceId, membership.workspaceId), notDeleted(spaces.deletedAt)),
        columns: { id: true },
      });
      for (const space of all) if (!closed!.spaces.has(space.id)) result.add(space.id);
    }
    return result;
  }

  /**
   * #469 — Databases this caller can read in full (ADR-0018). A database is visible when it is OPEN to them (a member, and neither
   * it nor its space is restricted), or they hold a grant on it, or they hold a grant on its space AND it is not itself restricted
   * (sticky). null = sees every database (admin, or a member in a workspace that restricts nothing).
   *
   * This computation existed as three drifting copies before ticket #469 — inline in `mentions.service.ts` `backlinks()`, again
   * inline in `search.controller.ts`, and nowhere at all in the two relation-chip readers that leaked a guest's denied
   * database's record titles. All call sites go through this one.
   */
  async visibleDatabaseIds(membership: Membership): Promise<Set<string> | null> {
    if (membership.role === 'admin') return null;
    const closed = await this.closedResources(membership);
    if (membership.role !== 'guest' && !closed) return null;
    const grants = await this.guestGrants(membership);
    const grantedSpaces = new Set(grants.map((g) => g.spaceId).filter((v): v is string => Boolean(v)));
    const grantedDatabases = new Set(grants.map((g) => g.databaseId).filter((v): v is string => Boolean(v)));
    const rows = await this.db.query.databases.findMany({
      where: and(eq(databases.workspaceId, membership.workspaceId), notDeleted(databases.deletedAt)),
      columns: { id: true, spaceId: true },
    });
    return new Set(
      rows
        .filter((d) => {
          const stickyClosed = closed?.databases.has(d.id) ?? false;
          const openToMe = membership.role !== 'guest' && !stickyClosed && !(closed?.spaces.has(d.spaceId) ?? false);
          return openToMe || grantedDatabases.has(d.id) || (grantedSpaces.has(d.spaceId) && !stickyClosed);
        })
        .map((d) => d.id),
    );
  }

  /**
   * #474 phase 4 — every record id this guest holds a DIRECT record-scoped
   * grant (#472) on, workspace-wide. For a query that spans multiple
   * databases and can't call `visibleRecordIds` once per database ahead of
   * time (global search, /recent) — the caller ORs this in alongside its
   * existing `visibleDatabaseIds`-based database filter, so a record-scoped-
   * only grant surfaces exactly that record without widening to its whole
   * database. null for admin/member (unrestricted, same as every other
   * guest-only primitive here).
   */
  async guestRecordGrantIds(membership: Membership): Promise<Set<string> | null> {
    if (membership.role === 'admin') return null;
    if (membership.role !== 'guest' && !(await this.closedResources(membership))) return null;
    const grants = await this.guestGrants(membership);
    return new Set(grants.map((g) => g.recordId).filter((v): v is string => Boolean(v)));
  }

  /**
   * #474 phase 4 — every database a guest can reach AT ALL: `visibleDatabaseIds`
   * (full access) UNION any database containing a record they hold a direct
   * record-scoped grant on. Deliberately NOT the same thing as "every record
   * in this database is visible" — a database appearing here purely via a
   * record-scoped grant still needs `visibleRecordIds` to narrow which rows
   * within it are actually visible. This exists so a per-database loop (e.g.
   * My Work) knows which databases to consider at all before doing that
   * per-record narrowing — `visibleDatabaseIds` alone would skip a database
   * where the guest's only access is a record grant, same class of gap #474
   * phase 3 fixed for relation chips. null for admin/member.
   */
  async reachableDatabaseIds(membership: Membership): Promise<Set<string> | null> {
    const broad = await this.visibleDatabaseIds(membership);
    if (broad === null) return null;
    const recordGrantIds = await this.guestRecordGrantIds(membership);
    if (!recordGrantIds || recordGrantIds.size === 0) return broad;
    const rows = await this.db.query.records.findMany({
      where: and(inArray(records.id, [...recordGrantIds]), notDeleted(records.deletedAt)),
      columns: { databaseId: true },
    });
    const merged = new Set(broad);
    for (const r of rows) merged.add(r.databaseId);
    return merged;
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
    // ADR-0018 §7: members' record-scoped grants are out of scope for v1. The primitives would honour one, so the API refuses it
    // rather than opening a surface nobody designed.
    if (input.record_id && target.role !== 'guest') {
      throw new UnprocessableEntityException('Record-scoped access is for guests; members get space and database access');
    }

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
    forgetForRequest('grants:');
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
    forgetForRequest('grants:');
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
