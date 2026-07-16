import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, documents } from '../db/schema';
import { MentionsService } from '../mentions/mentions.service';

const MAX_BYTES = 2 * 1024 * 1024;

/** Pulls visible text out of arbitrary editor JSON (BlockNote nests {text} nodes). */
export function extractText(content: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === 'string') parts.push(obj.text);
      Object.values(obj).forEach(walk);
    }
  };
  walk(content);
  return parts.join(' ').slice(0, 100_000);
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mentions: MentionsService,
  ) {}

  /** Lazily created: a record without a document reads as version 0. */
  async get(recordId: string) {
    const row = await this.db.query.documents.findFirst({
      where: eq(documents.recordId, recordId),
    });
    if (!row) return { record_id: recordId, content: null, version: 0, updated_at: null };
    return {
      record_id: recordId,
      content: row.content,
      version: row.version,
      updated_at: row.updatedAt,
    };
  }

  /** Single-editor optimistic concurrency: stale expected_version → 409 + current. */
  async put(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    content: unknown,
    expectedVersion: number,
    actorId: string,
  ) {
    const size = Buffer.byteLength(JSON.stringify(content ?? null));
    if (size > MAX_BYTES) {
      throw new UnprocessableEntityException(
        `Document too large (${size} bytes; limit ${MAX_BYTES}). This is deliberate — descriptions are not file storage.`,
      );
    }

    const contentText = extractText(content);
    const existing = await this.db.query.documents.findFirst({
      where: eq(documents.recordId, recordId),
    });
    const currentVersion = existing?.version ?? 0;

    if (expectedVersion !== currentVersion) {
      throw new ConflictException({
        message: 'Document was edited elsewhere',
        details: [{ path: 'expected_version', message: `current version is ${currentVersion}` }],
      });
    }

    const result = await this.db.transaction(async (tx) => {
      let saved;
      if (existing) {
        [saved] = await tx
          .update(documents)
          .set({ content, contentText, version: currentVersion + 1 })
          .where(eq(documents.recordId, recordId))
          .returning();
      } else {
        [saved] = await tx
          .insert(documents)
          .values({ recordId, content, contentText, version: 1 })
          .returning();
      }
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'document.edited',
        payload: {},
      });
      return { record_id: recordId, content: saved!.content, version: saved!.version, updated_at: saved!.updatedAt };
    });

    // Reconcile #record backlinks + @mention notifications (MN-205). Best-effort:
    // never fail the save because mention bookkeeping hiccuped.
    try {
      await this.mentions.syncRecordMentions(workspaceId, databaseId, recordId, actorId, {
        snippet: contentText.slice(0, 140),
      });
    } catch {
      // swallowed on purpose — the document is already saved.
    }

    return result;
  }
}
