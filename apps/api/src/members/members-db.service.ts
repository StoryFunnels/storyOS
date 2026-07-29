import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  databases as databasesTable,
  fields as fieldsTable,
  memberships as membershipsTable,
  records as recordsTable,
  selectOptions,
  user as userTable,
} from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { SpacesService } from '../workspaces/spaces.service';

/** The Members database name. Identified by name, like the Agentic OS pack
 *  (`AgentsService.findPackDbs`) — there is no per-database `is_system` column,
 *  so the name IS the flag. `SYSTEM_DATABASE_NAMES` (common/system-databases.ts)
 *  is the single source of truth that keeps it out of exports and onboarding
 *  progress the same way `SYSTEM_DBS` did for the Agentic OS pack. */
export const MEMBERS_DB_NAME = 'Members';

/** How many Member rows one upsert/tombstone scans to find an existing row.
 *  A workspace's member count is tiny relative to this (mirrors MAX_SCAN in
 *  packs/agents), so one page always covers it. */
const MAX_MEMBERS_SCAN = 500;

/** The write actor for every projection write — the projection reflects
 *  auth, it is nobody's manual edit. Stored in `created_by` as a plain text id
 *  exactly like anonymous public-form submissions (`created_by` is nullable
 *  text, never a membership fk). */
const SYSTEM_ACTOR = 'system:members-projection';

/**
 * A Members-database row resolved for a better-auth user id — the shape a
 * caller reads when traversing a `user`-typed field (e.g. `assignee`) to the
 * person's Members record (#128 Phase 2). `active: false` is a tombstoned
 * (removed) member: still resolvable, never an error.
 */
export interface ResolvedMember {
  /** The Members-database record id (the relation target). */
  recordId: string;
  /** The better-auth user id this row projects (the `User ID` field). */
  userId: string;
  /** The person's display name — the Members record title. */
  name: string;
  email: string | null;
  avatar: string | null;
  active: boolean;
}

/**
 * The Members system database (#128 Phase 1) — a first-class, per-workspace
 * projection of workspace memberships. Rows are people-in-THIS-workspace,
 * including guests (a guest is a `memberships` row with role `guest`). It is a
 * ONE-WAY projection: better-auth is the identity source of truth and the
 * Members database reflects it, never the reverse (name/avatar sync-back is
 * Phase 2, out of scope here).
 *
 * Provisioning mirrors `AgentsService.ensurePack`: find-or-create a system
 * space + the database + its fields, idempotent by name so a second call adds
 * nothing. Rows are keyed by better-auth `user_id` so upsert/tombstone are
 * idempotent too — re-running a backfill never duplicates a database or a row.
 */
@Injectable()
export class MembersDbService {
  private readonly logger = new Logger(MembersDbService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
    private readonly records: RecordsService,
    private readonly spaces: SpacesService,
  ) {}

  // ── Provisioning ──────────────────────────────────────────────────────────

  /** Find the workspace's Members database by name, if provisioned. */
  private async findMembersDb(workspaceId: string) {
    return this.db.query.databases.findFirst({
      where: and(
        eq(databasesTable.workspaceId, workspaceId),
        eq(databasesTable.name, MEMBERS_DB_NAME),
      ),
    });
  }

  /**
   * A membership object carrying just the workspace id — enough for
   * `DatabasesService.create`/`SpacesService.list`, which read only
   * `membership.workspaceId`. The projection is event-driven and system-owned,
   * so there is no request principal to thread through; this keeps those calls
   * honest without inventing a fake user identity that could leak into a write.
   */
  private actingMembership(workspaceId: string): Membership {
    return { workspaceId } as Membership;
  }

  /**
   * Find-or-create the "Members" database and its fields. Idempotent by database
   * name: a second call returns the same database and adds nothing (mirrors
   * `AgentsService.ensurePack`). Fields are back-filled individually so a
   * workspace provisioned by an earlier release gains any newly-added field on
   * its next ensure.
   *
   * Lives in the workspace's default (first) space rather than a system space of
   * its own — a workspace always has at least one space (the "General" space
   * created with it), so this adds no surprising top-level space to every
   * workspace, while still surfacing Members as a first-class database.
   */
  async ensureMembersDb(workspaceId: string) {
    const existing = await this.findMembersDb(workspaceId);
    if (existing) {
      await this.ensureMemberFields(existing.id);
      return existing;
    }

    const acting = this.actingMembership(workspaceId);
    const allSpaces = await this.spaces.list(acting);
    const space = allSpaces[0];
    if (!space) {
      // A workspace with no space can't host the database. This never happens
      // for a real workspace (creation makes the "General" space atomically),
      // so it is a guard, not a path — leave provisioning for the next ensure.
      throw new Error(`Cannot provision Members database: workspace ${workspaceId} has no space`);
    }

    const database = (await this.databasesService.create(acting, {
      space_id: space.id,
      name: MEMBERS_DB_NAME,
      icon: '👥',
    })) as { id: string };

    await this.ensureMemberFields(database.id);
    // Re-read so the shape matches the `findMembersDb` return (full row).
    return (await this.findMembersDb(workspaceId))!;
  }

  /** Add each projection field if it isn't already present, found by api_name —
   *  the idempotent back-fill shape `AgentsService.ensureField` uses. */
  private async ensureMemberFields(databaseId: string): Promise<void> {
    // The record title (auto `name` field) holds the person's display name.
    await this.ensureField(databaseId, 'email', { display_name: 'Email', type: 'email', config: {} });
    // No dedicated image field type exists (#128 note); the better-auth
    // `user.image` is a URL, so the avatar is stored as a url field.
    await this.ensureField(databaseId, 'avatar', { display_name: 'Avatar', type: 'url', config: {} });
    await this.ensureField(databaseId, 'role', {
      display_name: 'Role',
      type: 'select',
      config: {},
      // Mirrors the `membership_role` enum (admin | member | guest — guests are
      // the external people the projection is required to include).
      options: [
        { label: 'admin', color: 'red' },
        { label: 'member', color: 'blue' },
        { label: 'guest', color: 'gray' },
      ],
    });
    // The active/status marker. A removed member is tombstoned by flipping this
    // to false, never deleted — assigned-record history must survive (#128).
    await this.ensureField(databaseId, 'active', {
      display_name: 'Active',
      type: 'checkbox',
      config: {},
    });
    // The projection key: better-auth user id, stable across name/email/role
    // changes. Kept as a plain text field so upsert/tombstone can locate the row.
    await this.ensureField(databaseId, 'user_id', {
      display_name: 'User ID',
      type: 'text',
      config: {},
    });
  }

  private async ensureField(
    databaseId: string,
    apiName: string,
    spec: Parameters<FieldsService['create']>[1],
  ): Promise<void> {
    const existing = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    if (!existing) await this.fields.create(databaseId, spec);
  }

  /** label → option id for the Role select field, for writing the role value. */
  private async roleOptionIds(databaseId: string): Promise<Map<string, string>> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, 'role')),
    });
    if (!field) return new Map();
    const options = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, field.id),
    });
    return new Map(options.map((o) => [o.label, o.id]));
  }

  // ── Projection ────────────────────────────────────────────────────────────

  /** The existing Member row for a user, located by the `user_id` key, or null. */
  private async findMemberRow(databaseId: string, userId: string) {
    const { data } = await this.records.list(databaseId, { limit: MAX_MEMBERS_SCAN });
    return data.find((r) => r.values['user_id'] === userId) ?? null;
  }

  /**
   * Upsert the Member row for one membership (invite accepted / user joins, or a
   * role change). Ensures the database exists first, so the owner's very first
   * membership provisions the whole thing. Idempotent: an existing row is
   * updated in place (and re-activated, e.g. a removed member who re-joins),
   * never duplicated.
   */
  async syncMembership(workspaceId: string, userId: string): Promise<void> {
    const membership = await this.db.query.memberships.findFirst({
      where: and(
        eq(membershipsTable.workspaceId, workspaceId),
        eq(membershipsTable.userId, userId),
      ),
    });
    // Gone between emit and handling: treat as a removal so we never leave the
    // row falsely active.
    if (!membership) {
      await this.tombstoneMembership(workspaceId, userId);
      return;
    }

    const database = await this.ensureMembersDb(workspaceId);
    const account = await this.db.query.user.findFirst({ where: eq(userTable.id, userId) });
    const roleIds = await this.roleOptionIds(database.id);

    const values: Record<string, unknown> = {
      name: account?.name ?? account?.email ?? '(unknown user)',
      email: account?.email ?? null,
      avatar: account?.image ?? null,
      role: roleIds.get(membership.role) ?? null,
      active: true,
      user_id: userId,
    };

    const existing = await this.findMemberRow(database.id, userId);
    if (existing) {
      await this.records.update(workspaceId, database.id, existing.id, values, SYSTEM_ACTOR);
    } else {
      await this.records.create(workspaceId, database.id, values, SYSTEM_ACTOR);
    }
  }

  /**
   * Tombstone the Member row for a removed membership: mark it inactive, keep
   * it. A hard delete would orphan every record assigned to that person, so the
   * row survives as an inactive projection (#128 Phase 1). No-op if the database
   * or row was never provisioned.
   */
  async tombstoneMembership(workspaceId: string, userId: string): Promise<void> {
    const database = await this.findMembersDb(workspaceId);
    if (!database) return;
    const existing = await this.findMemberRow(database.id, userId);
    if (!existing) return;
    if (existing.values['active'] === false) return; // already tombstoned
    await this.records.update(
      workspaceId,
      database.id,
      existing.id,
      { active: false },
      SYSTEM_ACTOR,
    );
  }

  // ── Resolution (Phase 2, #128) ─────────────────────────────────────────────

  /**
   * Resolve better-auth user ids — the values stored on a `user`-typed field
   * such as `assignee` — to their Members-database rows, keyed by user id. This
   * is the read seam that makes `assignee → member.name/email/avatar`
   * traversable (a lookup/relation-style read) WITHOUT changing how the `user`
   * field itself is stored, written, filtered or sorted: the field still holds a
   * bare user id, and this maps that id to the projected Members row.
   *
   * Tombstoned members are included — an `assignee` pointing at a removed member
   * resolves to that person's inactive row (`active: false`), never an error.
   * A user id with no Members row (should not occur once `backfillWorkspace` has
   * run, which reconciles assignee-referenced users) is simply absent from the
   * map. Matches by the `User ID` field, the projection's stable key.
   */
  async resolveMembersForUsers(
    workspaceId: string,
    userIds: readonly string[],
  ): Promise<Map<string, ResolvedMember>> {
    const wanted = new Set(userIds.filter((id) => typeof id === 'string' && id.trim().length > 0));
    const out = new Map<string, ResolvedMember>();
    if (wanted.size === 0) return out;

    const database = await this.findMembersDb(workspaceId);
    if (!database) return out;

    const { data } = await this.records.list(database.id, { limit: MAX_MEMBERS_SCAN });
    for (const row of data) {
      const uid = row.values['user_id'];
      if (typeof uid !== 'string' || !wanted.has(uid)) continue;
      const email = row.values['email'];
      const avatar = row.values['avatar'];
      out.set(uid, {
        recordId: row.id,
        userId: uid,
        name: row.title,
        email: typeof email === 'string' ? email : null,
        avatar: typeof avatar === 'string' ? avatar : null,
        active: row.values['active'] === true,
      });
    }
    return out;
  }

  // ── Backfill ──────────────────────────────────────────────────────────────

  /**
   * Provision the Members database for an existing workspace and project a row
   * for every current active membership — members AND guests. Idempotent: safe
   * to re-run, upserting each row by `user_id` without duplicating anything.
   *
   * Phase 2 (#128): also reconcile every user id referenced by a `user` field
   * (e.g. `assignee`) so existing assignee data resolves to a Members row even
   * when the assignee is no longer an active membership.
   */
  async backfillWorkspace(workspaceId: string): Promise<void> {
    await this.ensureMembersDb(workspaceId);
    const rows = await this.db.query.memberships.findMany({
      where: and(
        eq(membershipsTable.workspaceId, workspaceId),
        eq(membershipsTable.status, 'active'),
      ),
    });
    for (const m of rows) {
      await this.syncMembership(workspaceId, m.userId);
    }
    await this.reconcileAssignedUsers(workspaceId);
  }

  /**
   * Ensure a Members row exists for every user id referenced by any `user`-typed
   * field across the workspace's records (e.g. `assignee`). Active memberships
   * already have rows (projected above); this closes the gap for a user who was
   * assigned and then removed BEFORE the projection existed — otherwise their
   * assignee value would resolve to nothing. Such an orphan gets an INACTIVE row
   * (it is not a current membership), while an existing row (active or already
   * tombstoned) is left exactly as-is. Idempotent — keyed by `user_id`, safe to
   * re-run.
   */
  async reconcileAssignedUsers(workspaceId: string): Promise<void> {
    const userIds = await this.referencedUserIds(workspaceId);
    if (userIds.size === 0) return;
    const database = await this.ensureMembersDb(workspaceId);
    for (const userId of userIds) {
      const existing = await this.findMemberRow(database.id, userId);
      if (existing) continue; // active or tombstoned row already present — leave it
      await this.projectInactiveUser(database.id, workspaceId, userId);
    }
  }

  /** Every distinct non-empty user id stored on a live `user`-typed field across
   *  the workspace's databases (single value or the `multi` array form). */
  private async referencedUserIds(workspaceId: string): Promise<Set<string>> {
    const out = new Set<string>();
    const dbs = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, workspaceId),
      columns: { id: true },
    });
    if (dbs.length === 0) return out;

    const userFields = await this.db.query.fields.findMany({
      where: and(
        inArray(
          fieldsTable.databaseId,
          dbs.map((d) => d.id),
        ),
        eq(fieldsTable.type, 'user'),
        isNull(fieldsTable.deletedAt),
      ),
      columns: { id: true, databaseId: true },
    });
    if (userFields.length === 0) return out;

    const fieldIdsByDb = new Map<string, string[]>();
    for (const f of userFields) {
      fieldIdsByDb.set(f.databaseId, [...(fieldIdsByDb.get(f.databaseId) ?? []), f.id]);
    }

    const collect = (value: unknown) => {
      if (typeof value === 'string' && value.trim().length > 0) out.add(value);
      else if (Array.isArray(value)) for (const v of value) collect(v);
    };

    for (const [databaseId, fieldIds] of fieldIdsByDb) {
      // Raw rows: `values` is keyed by field UUID (ADR-0002), not api_name.
      const rows = await this.db.query.records.findMany({
        where: and(eq(recordsTable.databaseId, databaseId), isNull(recordsTable.deletedAt)),
        columns: { values: true },
      });
      for (const row of rows) {
        const values = row.values as Record<string, unknown>;
        for (const fieldId of fieldIds) collect(values[fieldId]);
      }
    }
    return out;
  }

  /** Create an inactive Members row for a user who is referenced by a `user`
   *  field but is not a current active membership. No-op if the better-auth user
   *  is unknown (stale/bogus id) — nothing to project. */
  private async projectInactiveUser(
    databaseId: string,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const account = await this.db.query.user.findFirst({ where: eq(userTable.id, userId) });
    if (!account) return;
    await this.records.create(
      workspaceId,
      databaseId,
      {
        name: account.name ?? account.email ?? '(unknown user)',
        email: account.email ?? null,
        avatar: account.image ?? null,
        role: null,
        active: false,
        user_id: userId,
      },
      SYSTEM_ACTOR,
    );
  }

  /**
   * Backfill every workspace (existing-workspace provisioning path). Best-effort
   * and isolated per workspace — one workspace failing must not abort the rest.
   * Run once at boot (see MembersProjectionSubscriber), and cheap on re-run
   * because provisioning and every row upsert are idempotent.
   */
  async backfillAll(): Promise<void> {
    const all = await this.db.query.workspaces.findMany({ columns: { id: true } });
    for (const ws of all) {
      try {
        await this.backfillWorkspace(ws.id);
      } catch (error) {
        this.logger.warn(`Members backfill failed for workspace ${ws.id}: ${String(error)}`);
      }
    }
  }
}
