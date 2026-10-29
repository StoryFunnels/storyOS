import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { MembershipEventsService } from '../events/membership-events.service';
import { MembersDbService } from '../members/members-db.service';
import {
  account,
  accessGrants,
  activityEvents,
  apiTokens,
  attachments,
  comments,
  databases,
  favorites,
  recordWatchers,
  viewerState,
  fields,
  memberships,
  notifications,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  records,
  runnerAgents,
  runnerPairingCodes,
  runners,
  session,
  skillMembers,
  skills,
  user,
  userPreferences,
  workspaceFiles,
} from '../db/schema';

/** The transaction type `db.transaction(async (tx) => ...)` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * GDPR data-subject tooling (MN-233): export everything held about a user and
 * erase/anonymize them. Identity is a tombstone — the `user` row's PII is wiped
 * so authored comments/records/activity render as "(deactivated)" — while the
 * opaque user id is retained on those rows so history stays referentially
 * intact. App tables carry the user id as bare `text` (no FK), so anonymizing
 * never breaks a constraint; the read layer already degrades a missing user to
 * "(deactivated)".
 */
@Injectable()
export class GdprService {
  constructor(
    @Inject(DB) private readonly db: Db,
    /**
     * #418 — so an erasure reaches the Members projection.
     *
     * The bus rather than MembersDbService directly, for the same reason
     * MembersService uses it: MembersDbModule sits above this in the import
     * graph and a direct dependency would close a cycle.
     */
    private readonly membershipEvents: MembershipEventsService,
    /** #494 — reads the subject's own Members row for the export payload. */
    private readonly membersDb: MembersDbService,
  ) {}

  /** Resolve a workspace membership id to its user id (404 if not a member). */
  private async resolveMember(workspaceId: string, membershipId: string) {
    const m = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.id, membershipId),
        eq(memberships.workspaceId, workspaceId),
      ),
    });
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }

  private async databaseIds(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: databases.id })
      .from(databases)
      .where(eq(databases.workspaceId, workspaceId));
    return rows.map((r) => r.id);
  }

  /** Records in this workspace that reference the user in a `user`-type field. */
  private async userFieldReferences(workspaceId: string, userId: string) {
    const userFields = await this.db
      .select({ id: fields.id, databaseId: fields.databaseId })
      .from(fields)
      .innerJoin(databases, eq(fields.databaseId, databases.id))
      .where(
        and(
          eq(databases.workspaceId, workspaceId),
          eq(fields.type, 'user'),
          isNull(fields.deletedAt),
        ),
      );
    const refs: { record_id: string; database_id: string; field_id: string }[] =
      [];
    for (const f of userFields) {
      const hits = await this.db
        .select({ id: records.id })
        .from(records)
        .where(
          and(
            eq(records.databaseId, f.databaseId),
            isNull(records.deletedAt),
            // user fields hold either a scalar id or an array of ids
            sql`(${records.values} ->> ${f.id} = ${userId} OR (jsonb_typeof(${records.values} -> ${f.id}) = 'array' AND ${records.values} -> ${f.id} @> ${JSON.stringify([userId])}::jsonb))`,
          ),
        );
      for (const h of hits)
        refs.push({
          record_id: h.id,
          database_id: f.databaseId,
          field_id: f.id,
        });
    }
    return refs;
  }

  /**
   * #493 — the one piece of "does erasure reach every isSystem database"
   * that's actually fixable without inventing content-scanning: a `user`-type
   * field (system OR admin-added, on ANY database in the workspace — the
   * Agentic OS pack included, if one is ever added there) is a real,
   * structurally-identifiable reference to a specific person, unlike free
   * text. `userFieldReferences` already finds every hit for the EXPORT path;
   * this clears them for erasure, generalizing #463's "enumerate and null"
   * past Members to every database at once — a narrower, more principled fix
   * than three more copies of the same patch. Leaves the value's OTHER
   * elements alone on a multi-user field (an array), and never touches
   * `createdBy`/`updatedBy` or free-text content — both deliberately excluded
   * everywhere else in this file, for the same audit-lineage reason.
   */
  private async clearUserFieldReferences(
    tx: Tx,
    refs: { record_id: string; database_id: string; field_id: string }[],
    userId: string,
  ): Promise<number> {
    let cleared = 0;
    for (const ref of refs) {
      const [row] = await tx
        .select({ values: records.values })
        .from(records)
        .where(eq(records.id, ref.record_id));
      if (!row) continue;
      const values = { ...(row.values as Record<string, unknown>) };
      const current = values[ref.field_id];
      values[ref.field_id] = Array.isArray(current)
        ? current.filter((v) => v !== userId)
        : null;
      await tx.update(records).set({ values }).where(eq(records.id, ref.record_id));
      cleared++;
    }
    return cleared;
  }

  /**
   * Everything held about the user within this workspace, plus their global
   * profile. Machine-readable JSON; token hashes and secrets are never included.
   *
   * #494 — decision, stated rather than left as an unnoticed side effect: this
   * is addressed by `membershipId`, and `resolveMember` 404s once that row is
   * gone — so a departed member (erased, or otherwise removed) does NOT get an
   * export through this endpoint. That is deliberate, not a gap this ticket
   * introduces: there is no other stable identifier to address a subject-
   * access request by once the membership itself no longer exists, and
   * generating one retroactively for someone already erased would work
   * against the erasure it's supposed to describe. A pre-erasure export is
   * the intended window for this data — this ticket makes sure the Members
   * row is actually IN that window (see `members_row` below), not that the
   * window stays open forever.
   */
  async export(workspaceId: string, membershipId: string) {
    const member = await this.resolveMember(workspaceId, membershipId);
    const userId = member.userId;
    const dbIds = await this.databaseIds(workspaceId);

    const profileRow = await this.db.query.user.findFirst({
      where: eq(user.id, userId),
    });

    const grantRows = await this.db.query.accessGrants.findMany({
      where: and(
        eq(accessGrants.workspaceId, workspaceId),
        eq(accessGrants.userId, userId),
      ),
    });

    // #841 — a person's skill shares are their personal data: which skills in this workspace
    // name them (`skill_members`), and which skills they authored. Both are in the export, and
    // the shares are erased below with the rest of their access. A table GDPR does not know
    // about is a compliance hole nobody notices until it matters.
    const skillShares = await this.db
      .select({ skill_id: skills.id, name: skills.name, visibility: skills.visibility, shared_at: skillMembers.createdAt })
      .from(skillMembers)
      .innerJoin(skills, eq(skills.id, skillMembers.skillId))
      .where(and(eq(skills.workspaceId, workspaceId), eq(skillMembers.userId, userId)));
    const authoredSkills = await this.db
      .select({ id: skills.id, name: skills.name, visibility: skills.visibility, created_at: skills.createdAt })
      .from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.ownerId, userId)));

    const authoredRecords = dbIds.length
      ? await this.db
          .select({
            id: records.id,
            database_id: records.databaseId,
            title: records.title,
            created_at: records.createdAt,
            created: sql<boolean>`${records.createdBy} = ${userId}`,
            last_edited: sql<boolean>`${records.updatedBy} = ${userId}`,
          })
          .from(records)
          .where(
            and(
              inArray(records.databaseId, dbIds),
              sql`(${records.createdBy} = ${userId} OR ${records.updatedBy} = ${userId})`,
            ),
          )
      : [];

    const authoredComments = dbIds.length
      ? await this.db
          .select({
            id: comments.id,
            record_id: comments.recordId,
            body: comments.body,
            created_at: comments.createdAt,
            edited_at: comments.editedAt,
            deleted_at: comments.deletedAt,
          })
          .from(comments)
          .innerJoin(records, eq(comments.recordId, records.id))
          .where(
            and(
              inArray(records.databaseId, dbIds),
              eq(comments.authorId, userId),
            ),
          )
      : [];

    const activity = await this.db
      .select({
        id: activityEvents.id,
        type: activityEvents.type,
        record_id: activityEvents.recordId,
        created_at: activityEvents.createdAt,
      })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, workspaceId),
          eq(activityEvents.actorId, userId),
        ),
      );

    const favoriteRows = await this.db.query.favorites.findMany({
      where: and(
        eq(favorites.workspaceId, workspaceId),
        eq(favorites.userId, userId),
      ),
    });

    const notificationRows = await this.db
      .select({
        id: notifications.id,
        type: notifications.type,
        snippet: notifications.snippet,
        record_id: notifications.recordId,
        created_at: notifications.createdAt,
        read_at: notifications.readAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
        ),
      );

    // Token metadata only — never the hash.
    const tokenRows = await this.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        prefix: apiTokens.tokenPrefix,
        created_at: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.workspaceId, workspaceId),
          eq(apiTokens.userId, userId),
        ),
      );

    const uploadedAttachments = dbIds.length
      ? await this.db
          .select({
            id: attachments.id,
            filename: attachments.filename,
            record_id: attachments.recordId,
            created_at: attachments.createdAt,
          })
          .from(attachments)
          .innerJoin(records, eq(attachments.recordId, records.id))
          .where(
            and(
              inArray(records.databaseId, dbIds),
              eq(attachments.uploadedBy, userId),
            ),
          )
      : [];

    const uploadedFiles = await this.db
      .select({
        id: workspaceFiles.id,
        filename: workspaceFiles.filename,
        created_at: workspaceFiles.createdAt,
      })
      .from(workspaceFiles)
      .where(
        and(
          eq(workspaceFiles.workspaceId, workspaceId),
          eq(workspaceFiles.uploadedBy, userId),
        ),
      );

    const userFieldRefs = await this.userFieldReferences(workspaceId, userId);

    // #494 — Members is excluded from workspace export by design (the whole
    // database IS personal data), which meant a subject-access export never
    // showed the one row an admin can freely add columns to. null when the
    // Members database or this person's row doesn't exist.
    const membersRow = await this.membersDb.getOwnRowForExport(workspaceId, userId);

    return {
      schema: 'storyos.gdpr.export/1',
      workspace_id: workspaceId,
      subject_user_id: userId,
      // No wall-clock stamp here — callers add one; keeps the body deterministic.
      profile: profileRow
        ? {
            id: profileRow.id,
            name: profileRow.name,
            email: profileRow.email,
            email_verified: profileRow.emailVerified,
            image: profileRow.image,
            created_at: profileRow.createdAt,
            updated_at: profileRow.updatedAt,
          }
        : null,
      membership: {
        id: member.id,
        role: member.role,
        status: member.status,
        invited_by: member.invitedBy,
        joined_at: member.createdAt,
      },
      access_grants: grantRows.map((g) => ({
        id: g.id,
        space_id: g.spaceId,
        database_id: g.databaseId,
        role: g.role,
      })),
      skill_shares: skillShares,
      authored_skills: authoredSkills,
      authored_records: authoredRecords,
      authored_comments: authoredComments,
      activity,
      favorites: favoriteRows.map((f) => ({
        target_type: f.targetType,
        target_id: f.targetId,
      })),
      notifications: notificationRows,
      api_tokens: tokenRows,
      uploaded_attachments: uploadedAttachments,
      uploaded_files: uploadedFiles,
      user_field_references: userFieldRefs,
      members_row: membersRow,
    };
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
      throw new ConflictException(
        'Cannot erase the last admin — promote another admin first.',
      );
    }
  }

  /**
   * The part of an erasure that belongs to ONE workspace: the membership, the access grants, skill shares, favorites, per-viewer
   * state, watched records, notifications and `user`-field references in that workspace, and the API tokens minted for it (anonymised,
   * not deleted: a bound token's scope row is the attestation of what that credential could reach, #543, see `anonymiseTokens`).
   * Everything in here is keyed by the workspace id, so it can never reach another workspace.
   */
  private async removeWorkspaceFootprint(
    tx: Tx,
    workspaceId: string,
    membershipId: string,
    userId: string,
    userFieldRefs: Awaited<ReturnType<GdprService['userFieldReferences']>>,
  ) {
    await tx.delete(memberships).where(eq(memberships.id, membershipId));
    const grants = (await tx.delete(accessGrants).where(and(eq(accessGrants.workspaceId, workspaceId), eq(accessGrants.userId, userId))).returning()).length;
    // #841 — skill shares naming this person, scoped to THIS workspace's skills.
    const skillSharesRemoved = (
      await tx
        .delete(skillMembers)
        .where(and(eq(skillMembers.userId, userId), inArray(skillMembers.skillId, tx.select({ id: skills.id }).from(skills).where(eq(skills.workspaceId, workspaceId)))))
        .returning()
    ).length;
    const favs = (await tx.delete(favorites).where(and(eq(favorites.workspaceId, workspaceId), eq(favorites.userId, userId))).returning()).length;
    // #973 / ADR-0019 — the rest of this person's per-viewer state IN THIS workspace: their overrides and the records they watch.
    const viewerStateRows = (await tx.delete(viewerState).where(and(eq(viewerState.workspaceId, workspaceId), eq(viewerState.userId, userId))).returning({ k: viewerState.kind })).length;
    const watching = (await tx.delete(recordWatchers).where(and(eq(recordWatchers.workspaceId, workspaceId), eq(recordWatchers.userId, userId))).returning({ id: recordWatchers.id })).length;
    const notifs = (await tx.delete(notifications).where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId))).returning()).length;
    const userFieldsCleared = await this.clearUserFieldReferences(tx, userFieldRefs, userId);
    const tokens = await this.anonymiseTokens(tx, and(eq(apiTokens.userId, userId), eq(apiTokens.workspaceId, workspaceId)));
    await this.anonymiseRunners(tx, and(eq(runners.userId, userId), eq(runners.workspaceId, workspaceId)), and(eq(runnerPairingCodes.userId, userId), eq(runnerPairingCodes.workspaceId, workspaceId)));
    return {
      removed: {
        memberships: 1,
        access_grants: grants,
        skill_shares: skillSharesRemoved,
        favorites: favs,
        viewer_state: viewerStateRows,
        record_watchers: watching,
        notifications: notifs,
        user_field_references: userFieldsCleared,
      },
      tokens,
    };
  }

  /**
   * #543 — ANONYMISE, do not delete. A bound token's scope row is the only record of what that credential could reach, and the
   * attestation ("this token could reach database Y between A and B") is a statement about blast radius that needs no name on it.
   * Erasure must not void it, so the row stays and everything about a PERSON goes. Every column, decided (the schema comment on
   * `apiTokens` points back here):
   *   user_id      -> `erased:<token id>`   a person (no FK; nothing resolves it)
   *   name         -> 'Erased token'        free text; people write "Daria's laptop" in it
   *   token_hash   -> fresh random digest   a credential; the row can never authenticate again
   *   token_prefix -> 'erased'              first/last characters of the credential
   *   last_used_at -> NULL                  one person's behavioural timing, not needed for scope
   *   revoked_at   -> now() if still live   closes the window the attestation reports
   *   KEPT: id, workspace_id, scope, allow_run_button, origin, agent_id (an Agent record, not a person), resource_scope, created_at
   *   (opens the window); updated_at is stamped.
   * Whether this satisfies an erasure request is a legal question, not decided here.
   */
  /**
   * #1131 — a Runner is a person's own computer: its name ("Daria's MacBook"), its token and the tools on it are about a PERSON, so an
   * erasure revokes it and strips all of that. The row is kept (an audit line may still name the Runner by its id), the way
   * `anonymiseTokens` keeps a token row. Every column, decided:
   *   user_id -> `erased:<id>`; name -> 'Erased Runner'; token_hash -> fresh random digest (can never authenticate); token_prefix ->
   *   'erased'; tools/versions/last_seen_at/chosen_tool cleared; status -> revoked. Its agent assignments and the person's pairing codes
   *   are deleted outright (a code row holds only a hash and a user id).
   */
  private async anonymiseRunners(tx: Tx, runnerWhere: ReturnType<typeof and>, codeWhere: ReturnType<typeof and>): Promise<void> {
    const rows = await tx.select({ id: runners.id, status: runners.status, revokedAt: runners.revokedAt }).from(runners).where(runnerWhere);
    for (const r of rows) {
      await tx.delete(runnerAgents).where(eq(runnerAgents.runnerId, r.id));
      await tx
        .update(runners)
        .set({
          userId: `erased:${r.id}`,
          name: 'Erased Runner',
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          tokenPrefix: 'erased',
          status: 'revoked',
          revokedAt: r.revokedAt ?? new Date(),
          revokedReason: 'erased',
          pendingExpiresAt: null,
          tools: [],
          chosenTool: null,
          runnerVersion: null,
          protocolVersion: null,
          lastSeenAt: null,
          updatedAt: new Date(),
        })
        .where(eq(runners.id, r.id));
    }
    await tx.delete(runnerPairingCodes).where(codeWhere);
  }

  private async anonymiseTokens(tx: Tx, where: ReturnType<typeof and>): Promise<number> {
    const tokenRows = await tx.select({ id: apiTokens.id, revokedAt: apiTokens.revokedAt }).from(apiTokens).where(where);
    for (const t of tokenRows) {
      await tx
        .update(apiTokens)
        .set({
          userId: `erased:${t.id}`,
          name: 'Erased token',
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          tokenPrefix: 'erased',
          lastUsedAt: null,
          revokedAt: t.revokedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(apiTokens.id, t.id));
    }
    return tokenRows.length;
  }

  /**
   * #1039 — erase a member FROM THIS WORKSPACE. This is what a workspace admin may do, and it is deliberately only that: their
   * membership, access and per-person state here, and the tokens minted for this workspace. The person's GLOBAL identity (the
   * `user` row, their sign-in, their sessions, their tokens and OAuth connections in every other workspace) is NOT touched: one
   * workspace's admin does not own it. Before this, an admin of any workspace (anyone, on hosted) could run it on any member or
   * guest and lock that person out of every other workspace, with no way to even reset their password.
   *
   * Authored content is retained, keyed by the user id, so threads and history stay intact. The person's global erasure is
   * `eraseGlobalIdentity`, which only they can ask for.
   */
  async anonymize(
    workspaceId: string,
    membershipId: string,
  ): Promise<{
    anonymized: boolean;
    already_anonymized: boolean;
    user_id: string;
    scope: 'workspace';
    identity_erased: false;
    removed: Record<string, number>;
  }> {
    const member = await this.resolveMember(workspaceId, membershipId);
    const userId = member.userId;
    if (member.role === 'admin') {
      await this.assertNotLastAdmin(workspaceId, membershipId);
    }
    // #493 — fetched before the transaction, same pattern as before; the actual clearing happens inside it.
    const userFieldRefs = await this.userFieldReferences(workspaceId, userId);

    const result = await this.db.transaction(async (tx) => {
      const existing = await tx.query.user.findFirst({ where: eq(user.id, userId) });
      const footprint = await this.removeWorkspaceFootprint(tx, workspaceId, membershipId, userId, userFieldRefs);
      return {
        anonymized: true,
        already_anonymized: existing?.email === `deleted-${userId}@anonymized.invalid`,
        user_id: userId,
        scope: 'workspace' as const,
        identity_erased: false as const,
        // #543 — kept with identity stripped (see anonymiseTokens), so NOT in `removed`.
        retained_anonymized: { api_tokens: footprint.tokens },
        removed: footprint.removed,
      };
    });

    /*
     * #418 — emitted AFTER commit, and never allowed to fail the erasure: the Members projection is a cache with a backfill. Only THIS
     * workspace's membership was deleted, so only its Members row is tombstoned; the person's real identity is intact elsewhere.
     */
    this.membershipEvents.emit({
      type: 'membership_erased',
      workspaceId,
      userId,
      anonymisedEmail: `deleted-${userId}@anonymized.invalid`,
      tombstone: true,
    });
    return result;
  }

  /**
   * #1039 — erase a person's GLOBAL identity: the `user` row becomes a tombstone (PII wiped), every credential, session, token and
   * OAuth connection is destroyed so the account can never sign in again, and they leave EVERY workspace (each one's footprint is
   * removed too). Self-service only (the controller's session check): it is the person's own identity, not a workspace admin's to
   * destroy. Refuses while they are the LAST admin of any workspace (it would orphan it): promote someone or delete the workspace first.
   */
  async eraseGlobalIdentity(userId: string): Promise<{ anonymized: true; user_id: string; scope: 'global'; identity_erased: true; workspaces_left: number; removed: Record<string, number> }> {
    const mine = await this.db.query.memberships.findMany({ where: eq(memberships.userId, userId) });
    const orphaning: string[] = [];
    for (const m of mine) {
      if (m.role !== 'admin' || m.status !== 'active') continue;
      try {
        await this.assertNotLastAdmin(m.workspaceId, m.id);
      } catch {
        orphaning.push(m.workspaceId);
      }
    }
    if (orphaning.length > 0) {
      throw new ConflictException(`You are the only admin of ${orphaning.length} workspace${orphaning.length === 1 ? '' : 's'}. Promote another admin or delete ${orphaning.length === 1 ? 'it' : 'them'} first, so nothing is left without an admin.`);
    }
    const refsByWorkspace = new Map<string, Awaited<ReturnType<GdprService['userFieldReferences']>>>();
    for (const m of mine) refsByWorkspace.set(m.workspaceId, await this.userFieldReferences(m.workspaceId, userId));
    // #1080 — read BEFORE the tombstone overwrites it: this is the identifier the erasure has to find and remove everywhere.
    const before = await this.db.query.user.findFirst({ where: eq(user.id, userId), columns: { email: true } });
    const anonymisedEmail = `deleted-${userId}@anonymized.invalid`;

    const result = await this.db.transaction(async (tx) => {
      const totals: Record<string, number> = {};
      const add = (k: string, n: number) => { totals[k] = (totals[k] ?? 0) + n; };
      for (const m of mine) {
        const footprint = await this.removeWorkspaceFootprint(tx, m.workspaceId, m.id, userId, refsByWorkspace.get(m.workspaceId)!);
        for (const [k, n] of Object.entries(footprint.removed)) add(k, n);
      }
      await tx
        .update(user)
        .set({ name: 'Deleted user', email: `deleted-${userId}@anonymized.invalid`, emailVerified: false, image: null, updatedAt: new Date() })
        .where(eq(user.id, userId));
      add('sessions', (await tx.delete(session).where(eq(session.userId, userId)).returning()).length);
      add('accounts', (await tx.delete(account).where(eq(account.userId, userId)).returning()).length);
      add('oauth_access_tokens', (await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId)).returning()).length);
      add('oauth_consents', (await tx.delete(oauthConsent).where(eq(oauthConsent.userId, userId)).returning()).length);
      add('oauth_applications', (await tx.delete(oauthApplication).where(eq(oauthApplication.userId, userId)).returning()).length);
      add('api_tokens_anonymized', await this.anonymiseTokens(tx, eq(apiTokens.userId, userId)));
      await this.anonymiseRunners(tx, eq(runners.userId, userId), eq(runnerPairingCodes.userId, userId)); // #1131
      add('user_preferences', (await tx.delete(userPreferences).where(eq(userPreferences.userId, userId)).returning()).length);
      if (before?.email && before.email !== anonymisedEmail) add('history_rows_scrubbed', await this.scrubEmailFromHistory(tx, before.email, anonymisedEmail));
      return totals;
    });

    /*
     * #1080 — NO `membership_erased` events here. They made the Members projection erase through `RecordsService.update`, which
     * wrote the old address as the "before" value of an email change into three history tables, and only reached workspaces the
     * person was still in. The Members row is erased directly instead, in EVERY workspace that has one (a person removed from a
     * workspace long ago still has a tombstoned row holding their real email there), and nothing is written to any workspace's log.
     */
    result['members_rows_erased'] = await this.membersDb.eraseEverywhere(userId, anonymisedEmail);
    return { anonymized: true, user_id: userId, scope: 'global', identity_erased: true, workspaces_left: mine.length, removed: result };
  }

  /**
   * #1080 — replace an email address wherever the change history quotes it: activity payloads, field changes (before/after),
   * version snapshots. The records themselves are NOT rewritten: a workspace's own data that happens to hold the same address (a contact, a note) is that workspace's content, retained like all authored content. Case-insensitive, and only
   * rows that mention it are rewritten. Returns the number of rows touched. An erasure is rare, so a scan is acceptable here.
   * Names are NOT replaced by text match (a short name would mangle unrelated text); the person's Members row, the one place their
   * name is history, is erased with its history instead (`MembersDbService.eraseEverywhere`).
   */
  private async scrubEmailFromHistory(tx: Tx, email: string, replacement: string): Promise<number> {
    const pattern = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let n = 0;
    const run = async (q: ReturnType<typeof sql>) => {
      n += ((await tx.execute(q)) as unknown as { rowCount?: number }).rowCount ?? 0;
    };
    await run(sql`UPDATE activity_events SET payload = regexp_replace(payload::text, ${pattern}, ${replacement}, 'gi')::jsonb WHERE payload::text ~* ${pattern}`);
    await run(sql`UPDATE record_field_changes SET old_value = regexp_replace(old_value::text, ${pattern}, ${replacement}, 'gi')::jsonb WHERE old_value::text ~* ${pattern}`);
    await run(sql`UPDATE record_field_changes SET new_value = regexp_replace(new_value::text, ${pattern}, ${replacement}, 'gi')::jsonb WHERE new_value::text ~* ${pattern}`);
    await run(sql`UPDATE record_versions SET values = regexp_replace(values::text, ${pattern}, ${replacement}, 'gi')::jsonb WHERE values::text ~* ${pattern}`);
    await run(sql`UPDATE record_versions SET title = regexp_replace(title, ${pattern}, ${replacement}, 'gi') WHERE title ~* ${pattern}`);
    return n;
  }
}
