import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { normalizeIconInput } from '@storyos/schemas/icons';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaceDocuments, spaceFolders, spaces } from '../db/schema';
import { extractText } from './documents.service';

const MAX_BYTES = 2 * 1024 * 1024;

/** Standalone space-level documents (MN-095) — rich pages that live in the nav
 * tree next to databases, independent of any record. Single-editor optimistic
 * concurrency mirrors record descriptions. */
@Injectable()
export class SpaceDocumentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

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
   * #291 — a PERSONAL space is reachable only by its owner, admins included.
   *
   * 404s rather than 403s, matching the convention elsewhere: a distinguishable
   * "forbidden" would confirm that a given person has a personal space and that a
   * particular document id lives in it, which is itself the disclosure.
   */
  private async assertSpace(workspaceId: string, spaceId: string, actorUserId: string) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)),
      columns: { id: true, personal: true, ownerUserId: true },
    });
    if (!space) throw new NotFoundException('Space not found');
    if (space.personal && space.ownerUserId !== actorUserId) {
      throw new NotFoundException('Space not found');
    }
  }

  private async row(workspaceId: string, docId: string) {
    const row = await this.db.query.spaceDocuments.findFirst({
      where: and(eq(spaceDocuments.id, docId), eq(spaceDocuments.workspaceId, workspaceId), isNull(spaceDocuments.deletedAt)),
    });
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  async list(workspaceId: string, spaceId: string, actorUserId: string) {
    await this.assertSpace(workspaceId, spaceId, actorUserId);
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

  async create(workspaceId: string, spaceId: string, input: { title?: string; icon?: string }, actorId: string) {
    await this.assertSpace(workspaceId, spaceId, actorId);
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
        workspaceId,
        spaceId,
        title,
        icon,
        position: (last?.position ?? -1) + 1,
        createdBy: actorId,
      })
      .returning();
    return this.project(row!);
  }

  async get(workspaceId: string, docId: string) {
    return this.project(await this.row(workspaceId, docId));
  }

  async update(
    workspaceId: string,
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
    const existing = await this.row(workspaceId, docId);
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

  async remove(workspaceId: string, docId: string) {
    await this.row(workspaceId, docId);
    await this.db.update(spaceDocuments).set({ deletedAt: new Date() }).where(eq(spaceDocuments.id, docId));
    return { deleted: docId };
  }
}
