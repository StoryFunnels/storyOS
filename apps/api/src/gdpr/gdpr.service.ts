import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { MembershipEventsService } from '../events/membership-events.service';
import {
  account,
  accessGrants,
  activityEvents,
  apiTokens,
  attachments,
  comments,
  databases,
  favorites,
  fields,
  memberships,
  notifications,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  records,
  session,
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
   * Erase/anonymize the user. Tombstones the global `user` row (PII wiped),
   * destroys all credentials/sessions/tokens so they can never sign in again,
   * and removes their access in THIS workspace. Authored content is retained
   * (keyed by the now-tombstoned id) so threads and history stay intact.
   *
   * Anonymizing the `user` row is inherently global (one row per person); the
   * caller is a workspace admin, so we only strip *access* within their
   * workspace. Other workspaces keep the membership but see a "(deactivated)"
   * identity that can no longer authenticate.
   */
  async anonymize(
    workspaceId: string,
    membershipId: string,
  ): Promise<{
    anonymized: boolean;
    already_anonymized: boolean;
    user_id: string;
    removed: Record<string, number>;
  }> {
    const member = await this.resolveMember(workspaceId, membershipId);
    const userId = member.userId;
    if (member.role === 'admin') {
      await this.assertNotLastAdmin(workspaceId, membershipId);
    }

    /*
     * #418 — every workspace this person belongs to, captured BEFORE the
     * transaction removes one of them.
     *
     * `anonymize` wipes the GLOBAL `user` row, so a Members row in any OTHER
     * workspace is left holding a real name and email whose only source has just
     * been destroyed. Erasing only the requesting workspace would satisfy the
     * letter of the report and leave the same data sitting two clicks away.
     */
    const allMemberships = await this.db.query.memberships.findMany({
      where: eq(memberships.userId, userId),
      columns: { workspaceId: true },
    });

    // #493 — fetched before the transaction, same pattern as `allMemberships`
    // above; the actual clearing happens inside it, alongside everything else
    // this erasure touches.
    const userFieldRefs = await this.userFieldReferences(workspaceId, userId);

    const result = await this.db.transaction(async (tx) => {
      const existing = await tx.query.user.findFirst({
        where: eq(user.id, userId),
      });
      const tombstoneEmail = `deleted-${userId}@anonymized.invalid`;
      const alreadyAnon = existing?.email === tombstoneEmail;

      if (existing && !alreadyAnon) {
        await tx
          .update(user)
          .set({
            name: 'Deleted user',
            email: tombstoneEmail,
            emailVerified: false,
            image: null,
            updatedAt: new Date(),
          })
          .where(eq(user.id, userId));
      }

      // Destroy every credential/session so the account can never authenticate.
      const sessions = (
        await tx.delete(session).where(eq(session.userId, userId)).returning()
      ).length;
      const accounts = (
        await tx.delete(account).where(eq(account.userId, userId)).returning()
      ).length;
      const oauthTokens = (
        await tx
          .delete(oauthAccessToken)
          .where(eq(oauthAccessToken.userId, userId))
          .returning()
      ).length;
      const oauthConsents = (
        await tx
          .delete(oauthConsent)
          .where(eq(oauthConsent.userId, userId))
          .returning()
      ).length;
      const oauthApps = (
        await tx
          .delete(oauthApplication)
          .where(eq(oauthApplication.userId, userId))
          .returning()
      ).length;
      const tokens = (
        await tx.delete(apiTokens).where(eq(apiTokens.userId, userId)).returning()
      ).length;
      const prefs = (
        await tx
          .delete(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .returning()
      ).length;

      // Strip access in this workspace.
      await tx.delete(memberships).where(eq(memberships.id, membershipId));
      const grants = (
        await tx
          .delete(accessGrants)
          .where(
            and(
              eq(accessGrants.workspaceId, workspaceId),
              eq(accessGrants.userId, userId),
            ),
          )
          .returning()
      ).length;
      const favs = (
        await tx
          .delete(favorites)
          .where(
            and(
              eq(favorites.workspaceId, workspaceId),
              eq(favorites.userId, userId),
            ),
          )
          .returning()
      ).length;
      const notifs = (
        await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.workspaceId, workspaceId),
              eq(notifications.userId, userId),
            ),
          )
          .returning()
      ).length;

      const userFieldsCleared = await this.clearUserFieldReferences(tx, userFieldRefs, userId);

      return {
        anonymized: true,
        already_anonymized: alreadyAnon,
        user_id: userId,
        removed: {
          sessions,
          accounts,
          oauth_access_tokens: oauthTokens,
          oauth_consents: oauthConsents,
          oauth_applications: oauthApps,
          api_tokens: tokens,
          user_preferences: prefs,
          memberships: 1,
          access_grants: grants,
          favorites: favs,
          notifications: notifs,
          user_field_references: userFieldsCleared,
        },
      };
    });

    /*
     * #418 — emitted AFTER commit, and never allowed to fail the erasure.
     *
     * Same contract every other membership emit follows: the projection is a
     * cache with a backfill, not a transactional invariant, and a projection
     * hiccup must not turn a completed GDPR erasure into a reported failure. The
     * data is already gone from the source of truth at this point.
     *
     * `tombstone` is true only for the workspace the request was made in, where
     * the membership really was deleted. Elsewhere the person is still a member
     * and only the PII goes.
     */
    const tombstoneEmail = `deleted-${userId}@anonymized.invalid`;
    for (const m of allMemberships) {
      this.membershipEvents.emit({
        type: 'membership_erased',
        workspaceId: m.workspaceId,
        userId,
        anonymisedEmail: tombstoneEmail,
        tombstone: m.workspaceId === workspaceId,
      });
    }

    return result;
  }
}
