import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { diffBlocks } from '@storyos/schemas/block-diff';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, documentVersions, documents } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { EntitlementsService } from '../billing/entitlements.service';
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
    private readonly entitlements: EntitlementsService,
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
    source: ChangeSource = 'human',
    // #677 (Gap 2) — same optional trailing pair every other write path
    // (records, restoreVersion) already accepts.
    agentId?: string,
    agentName?: string,
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

    // #677 (Gap 2) — resolved OUTSIDE the transaction, same "a plan lookup
    // must not hold a row lock" reasoning RecordsService.update() already
    // applies to its own historyDays lookup. 0 ⇒ Free ⇒ capture nothing —
    // the ONE shared retention signal (EntitlementsService), not a second
    // hardcoded rule for documents.
    const { historyRetentionDays: historyDays } = await this.entitlements.getLimits(workspaceId);

    const result = await this.db.transaction(async (tx) => {
      let saved;
      if (existing) {
        // #677 (Gap 2) — snapshot the FULL prior content (+ the version
        // counter it was at) before overwriting, mirroring record_versions'
        // own "capture before the write lands" shape exactly. Only an EDIT
        // has a prior state to capture; the first-ever save has nothing to
        // snapshot, same as record create() never writing a record_versions row.
        if (historyDays > 0) {
          await tx.insert(documentVersions).values({
            workspaceId,
            recordId,
            actorId,
            source,
            agentId,
            agentName,
            content: existing.content,
            version: existing.version,
          });
        }
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
        agentId,
        agentName,
        source,
      });
      return { record_id: recordId, content: saved!.content, version: saved!.version, updated_at: saved!.updatedAt };
    });

    // Reconcile #record backlinks + @mention notifications (MN-205). Best-effort:
    // never fail the save because mention bookkeeping hiccuped.
    try {
      await this.mentions.syncRecordMentions(
        workspaceId,
        databaseId,
        recordId,
        actorId,
        { snippet: contentText.slice(0, 140) },
        source,
      );
    } catch {
      // swallowed on purpose — the document is already saved.
    }

    return result;
  }

  /** #677 (Gap 2) — version history, newest first (cursor-paginated), same shape RecordsService.listVersions uses. */
  async listVersions(recordId: string, limit: number, cursor?: string) {
    const conditions = [eq(documentVersions.recordId, recordId)];
    if (cursor) {
      const created = new Date(Buffer.from(cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(documentVersions.createdAt, created));
    }
    const rows = await this.db.query.documentVersions.findMany({
      where: and(...conditions),
      orderBy: [desc(documentVersions.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      data: page.map((v) => ({
        id: v.id,
        version: v.version,
        actor_id: v.actorId,
        source: v.source,
        agent_id: v.agentId,
        agent_name: v.agentName,
        created_at: v.createdAt,
      })),
      next_cursor:
        hasMore && page.length > 0
          ? Buffer.from(page[page.length - 1]!.createdAt.toISOString()).toString('base64url')
          : null,
      has_more: hasMore,
    };
  }

  /**
   * #677 (Gap 2) — a single version's block-level diff PREVIEW against the
   * CURRENT document, for a "confirm before restoring" UI — the same
   * read-only preview shape #39/PR#838 built for record_versions
   * (RecordsService.getVersion), and the exact #595 `diffBlocks` machinery
   * `record-diff.ts` already uses for a rich_text field's diff, applied here
   * directly since a document's content IS a bare block array already (no
   * field-value wrapper to unwrap first).
   */
  async getVersion(recordId: string, versionId: string) {
    const version = await this.db.query.documentVersions.findFirst({
      where: and(eq(documentVersions.id, versionId), eq(documentVersions.recordId, recordId)),
    });
    if (!version) throw new NotFoundException('Version not found');
    const current = await this.get(recordId);
    return {
      id: version.id,
      version: version.version,
      created_at: version.createdAt,
      actor_id: version.actorId,
      source: version.source,
      agent_id: version.agentId,
      agent_name: version.agentName,
      // Named from the CURRENT document's perspective, matching restore's own
      // framing ("this will go from X back to Y") — the reverse of diffBlocks'
      // (before=this version, after=current) argument order.
      blocks: diffBlocks(version.content, current.content),
    };
  }

  /**
   * #677 (Gap 2) — restore the document to a previously captured version.
   * The pre-restore content is itself snapshotted first (same transaction),
   * so a restore is never a one-way door — mirrors
   * RecordsService.restoreVersion exactly.
   */
  async restoreVersion(
    workspaceId: string,
    recordId: string,
    versionId: string,
    actorId: string,
    source: ChangeSource = 'human',
    agentId?: string,
    agentName?: string,
  ) {
    const version = await this.db.query.documentVersions.findFirst({
      where: and(eq(documentVersions.id, versionId), eq(documentVersions.recordId, recordId)),
    });
    if (!version) throw new NotFoundException('Version not found');

    const existing = await this.db.query.documents.findFirst({
      where: eq(documents.recordId, recordId),
    });
    if (!existing) throw new NotFoundException('Document not found');

    // #677 — same shared retention signal put() gates its own capture on;
    // a downgraded workspace stops accumulating NEW version rows even
    // though older ones (captured on a higher plan) remain restorable.
    const { historyRetentionDays: historyDays } = await this.entitlements.getLimits(workspaceId);

    const contentText = extractText(version.content);
    const result = await this.db.transaction(async (tx) => {
      if (historyDays > 0) {
        await tx.insert(documentVersions).values({
          workspaceId,
          recordId,
          actorId,
          source,
          agentId,
          agentName,
          content: existing.content,
          version: existing.version,
        });
      }
      const [saved] = await tx
        .update(documents)
        .set({ content: version.content, contentText, version: existing.version + 1 })
        .where(eq(documents.recordId, recordId))
        .returning();
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'document.edited',
        payload: { restored_from_version_id: versionId },
        source,
        agentId,
        agentName,
      });
      return { record_id: recordId, content: saved!.content, version: saved!.version, updated_at: saved!.updatedAt };
    });

    return result;
  }
}
