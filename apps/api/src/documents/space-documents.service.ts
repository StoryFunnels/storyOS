import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { normalizeIconInput } from '@storyos/schemas/icons';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaceDocuments, spaceFolders } from '../db/schema';
import { extractText } from './documents.service';
import { blocksToMarkdown } from '@storyos/schemas/markdown';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../workspaces/spaces.service';
import { collectMentions } from '../mentions/mentions.service';
import type { Membership } from '../workspaces/workspace-access.guard';

const MAX_BYTES = 2 * 1024 * 1024;

/** Standalone space-level documents (MN-095) — rich pages that live in the nav
 * tree next to databases, independent of any record. Single-editor optimistic
 * concurrency mirrors record descriptions. */
@Injectable()
export class SpaceDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly spaces: SpacesService,
  ) {}

  private project(row: typeof spaceDocuments.$inferSelect) {
    return {
      id: row.id,
      space_id: row.spaceId,
      title: row.title,
      icon: row.icon,
      content: row.content,
      version: row.version,
      position: row.position,
      created_by: row.createdBy,
      updated_at: row.updatedAt,
    };
  }

  /**
   * #238 — this used to check ONLY personal-space ownership (via a raw spaces
   * lookup) and never consulted AccessService at all: any active member OR
   * guest, including one holding zero grants anywhere, could create/read/edit/
   * delete a standalone document in ANY non-personal space, and personal-space
   * privacy (#291 — private from admins too) was unenforced on every route
   * except `create`. `AccessService.assertSpace` already does exactly what
   * this needs — the #291 personal check AND the grant-based space check — so
   * this delegates rather than re-implementing a second, incomplete copy.
   *
   * `min = 'viewer'` for reads, `'editor'` for writes, matching the space-owned
   * (dashboard) view rules in `SpaceViewsService` — a document is space content,
   * not schema, so it doesn't need `creator`.
   */
  private async assertSpace(membership: Membership, spaceId: string, min: 'viewer' | 'editor') {
    await this.access.assertSpace(membership, spaceId, min);
  }

  private async row(workspaceId: string, docId: string) {
    const row = await this.db.query.spaceDocuments.findFirst({
      where: and(eq(spaceDocuments.id, docId), eq(spaceDocuments.workspaceId, workspaceId), isNull(spaceDocuments.deletedAt)),
    });
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  async list(membership: Membership, spaceId: string) {
    await this.assertSpace(membership, spaceId, 'viewer');
    const rows = await this.db.query.spaceDocuments.findMany({
      where: and(eq(spaceDocuments.spaceId, spaceId), isNull(spaceDocuments.deletedAt)),
      orderBy: [asc(spaceDocuments.position), asc(spaceDocuments.createdAt)],
    });
    // #368 — folder_id was in the schema from MN-096 and never returned, so the
    // column has been dead since it was added. That dead column is what made
    // #347's ticket AND the merged ADR both claim documents were already
    // foldered: the schema advertised a capability nothing implemented.
    return rows.map((r) => ({ id: r.id, space_id: r.spaceId, folder_id: r.folderId, title: r.title, icon: r.icon }));
  }

  async create(membership: Membership, spaceId: string, input: { title?: string; icon?: string }, actorId: string) {
    await this.assertSpace(membership, spaceId, 'editor');
    const [last] = await this.db
      .select({ position: spaceDocuments.position })
      .from(spaceDocuments)
      .where(eq(spaceDocuments.spaceId, spaceId))
      .orderBy(desc(spaceDocuments.position))
      .limit(1);
    const title = input.title?.slice(0, 200) ?? 'Untitled';
    // #283: normalize through the emoji migration table —
    // space-documents.controller.ts only enforces z.string().max(48), no
    // `set:` requirement.
    const icon = normalizeIconInput(input.icon, title);
    const [row] = await this.db
      .insert(spaceDocuments)
      .values({
        workspaceId: membership.workspaceId,
        spaceId,
        title,
        icon,
        position: (last?.position ?? -1) + 1,
        createdBy: actorId,
      })
      .returning();
    return this.project(row!);
  }

  async get(membership: Membership, docId: string) {
    const existing = await this.row(membership.workspaceId, docId);
    await this.assertSpace(membership, existing.spaceId, 'viewer');
    return this.project(existing);
  }

  /**
   * #262 — same access rule as `get`: exporting shows you what you can already
   * read. Uses `@storyos/schemas/markdown`'s `blocksToMarkdown` — the SAME
   * converter `get_document` already renders through in packages/mcp — rather
   * than a second implementation against BlockNote's own library. That
   * matters beyond avoiding duplication: this converter already understands
   * StoryOS's own mention nodes (`@member`/`#record`), which a generic
   * BlockNote-library conversion would not render at all. What a person
   * downloads from "Export" and what an agent reads via get_document are
   * therefore the same text, not two approximations that can drift.
   */
  async exportMarkdown(membership: Membership, docId: string): Promise<{ title: string; markdown: string }> {
    const existing = await this.row(membership.workspaceId, docId);
    await this.assertSpace(membership, existing.spaceId, 'viewer');
    const body = blocksToMarkdown(existing.content);
    const markdown = `# ${existing.title}\n\n${body}`.trim() + '\n';
    return { title: existing.title, markdown };
  }

  async update(
    membership: Membership,
    docId: string,
    input: {
      title?: string;
      icon?: string | null;
      content?: unknown;
      expected_version?: number;
      /** #368 — sidebar placement. `undefined` leaves it alone; null unfiles. */
      folder_id?: string | null;
    },
  ) {
    const existing = await this.row(membership.workspaceId, docId);
    await this.assertSpace(membership, existing.spaceId, 'editor');
    const patch: Partial<typeof spaceDocuments.$inferInsert> = {};
    if (input.folder_id !== undefined) {
      if (input.folder_id !== null) {
        // #368 — a folder from ANOTHER space would render this document under a
        // sidebar it does not belong to, and nothing in the schema catches it.
        // Same guard views got in #347.
        const folder = await this.db.query.spaceFolders.findFirst({
          where: eq(spaceFolders.id, input.folder_id),
          columns: { spaceId: true },
        });
        if (!folder) throw new NotFoundException('Folder not found');
        if (folder.spaceId !== existing.spaceId) {
          throw new UnprocessableEntityException('That folder belongs to a different space.');
        }
      }
      patch.folderId = input.folder_id;
    }
    if (input.title !== undefined) patch.title = input.title.slice(0, 200);
    if (input.icon !== undefined) {
      patch.icon =
        input.icon === null ? null : (normalizeIconInput(input.icon, patch.title ?? existing.title) ?? input.icon);
    }

    if (input.content !== undefined) {
      const size = Buffer.byteLength(JSON.stringify(input.content ?? null));
      if (size > MAX_BYTES) {
        throw new UnprocessableEntityException(`Document too large (${size} bytes; limit ${MAX_BYTES}).`);
      }
      if (input.expected_version !== undefined && input.expected_version !== existing.version) {
        throw new ConflictException({
          message: 'Document was edited elsewhere',
          details: [{ path: 'expected_version', message: `current version is ${existing.version}` }],
        });
      }
      patch.content = input.content;
      patch.contentText = extractText(input.content);
      patch.version = existing.version + 1;
    }

    const [row] = await this.db
      .update(spaceDocuments)
      .set(patch)
      .where(eq(spaceDocuments.id, docId))
      .returning();
    return this.project(row!);
  }

  async remove(membership: Membership, docId: string) {
    const existing = await this.row(membership.workspaceId, docId);
    await this.assertSpace(membership, existing.spaceId, 'editor');
    await this.db.update(spaceDocuments).set({ deletedAt: new Date() }).where(eq(spaceDocuments.id, docId));
    return { deleted: docId };
  }

  /**
   * #293 — a document's personal-ness is entirely its `spaceId` pointing at a
   * personal space (schema.ts, personal-space.md) — "moving" it to shared is
   * a real UPDATE of that column, not a copy. One-way per the ADR: the
   * return trip is `copyToPersonal` below, a fork with no sync, never an
   * un-publish. Best-effort notify of the document's OWN mentions fires only
   * on a personal -> shared transition: a personal document's mentions are
   * suppressed at write time (personal-space.md — never notified at all), so
   * this move is the first moment they become visible; moving between two
   * already-shared spaces re-surfaces nothing new and never notifies again.
   */
  async moveToSpace(membership: Membership, docId: string, targetSpaceId: string, actorId: string) {
    const existing = await this.row(membership.workspaceId, docId);
    const source = await this.access.assertSpace(membership, existing.spaceId, 'editor');
    const target = await this.access.assertSpace(membership, targetSpaceId, 'editor');
    if (target.personal) {
      throw new UnprocessableEntityException(
        'Target must be a shared space — use copy-to-personal to fork a shared item into yours.',
      );
    }
    const [row] = await this.db
      .update(spaceDocuments)
      // #368: a folder belongs to the space it's foldered under — carrying it
      // across a space move would file this document under a sidebar folder
      // it no longer has any relationship to (same guard `update` enforces
      // when a client tries to hand it a foreign folder_id directly).
      .set({ spaceId: targetSpaceId, folderId: null })
      .where(eq(spaceDocuments.id, docId))
      .returning();

    if (source.personal) {
      const { userIds } = collectMentions(existing.content);
      if (userIds.length) {
        await this.notifications.notify({
          workspaceId: membership.workspaceId,
          actorId,
          type: 'mentioned',
          recipients: userIds,
          snippet: existing.title,
        });
      }
    }
    return this.project(row!);
  }

  /**
   * #293 — "Copy to My Space": fork a document the caller can see into an
   * independent copy in their OWN personal space, never sync'd back (the
   * ADR's answer to "publishing is one-way"). A fresh id/version/position —
   * editing either side afterward never touches the other.
   */
  async copyToPersonal(membership: Membership, docId: string, actorId: string) {
    const existing = await this.row(membership.workspaceId, docId);
    await this.assertSpace(membership, existing.spaceId, 'viewer');
    const personalSpace = await this.spaces.getOrCreatePersonal(membership.workspaceId, actorId);
    const [last] = await this.db
      .select({ position: spaceDocuments.position })
      .from(spaceDocuments)
      .where(eq(spaceDocuments.spaceId, personalSpace.id))
      .orderBy(desc(spaceDocuments.position))
      .limit(1);
    const [row] = await this.db
      .insert(spaceDocuments)
      .values({
        workspaceId: membership.workspaceId,
        spaceId: personalSpace.id,
        title: existing.title,
        icon: existing.icon,
        content: existing.content,
        contentText: existing.contentText,
        position: (last?.position ?? -1) + 1,
        createdBy: actorId,
      })
      .returning();
    return this.project(row!);
  }
}
