import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import type { Readable } from 'node:stream';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, attachments, fields, records } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { env } from '../config/env';
import { DomainEventsService } from '../events/domain-events.service';
import { getStorage } from './storage';

const THUMB_WIDTH = 320;

/** #599 — `StorageDriver.getStream` is the only read primitive; a physical
 *  file copy needs the whole thing in memory to `put()` it back out under a
 *  new key. Attachments are already capped by `ATTACHMENT_MAX_BYTES` on
 *  upload, so this never buffers more than one upload's worth at a time. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /**
   * The record-level BAG (MN-029), unchanged by #391.
   *
   * `field_id IS NULL` is the whole of the change: files that belong to an
   * attachment FIELD are that field's value and are read through the record, not
   * through here. Without this filter, adding a Cover field would have silently
   * doubled every record's attachment list — and #391 is explicit that the
   * existing bag keeps working exactly as it did.
   */
  async list(recordId: string) {
    const rows = await this.db.query.attachments.findMany({
      where: and(eq(attachments.recordId, recordId), isNull(attachments.fieldId)),
      orderBy: [desc(attachments.createdAt)],
    });
    return {
      data: rows.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mime: a.mime,
        has_thumbnail: Boolean(a.thumbKey),
        uploaded_by: a.uploadedBy,
        created_at: a.createdAt,
      })),
    };
  }

  /**
   * #391 — `fieldId` puts the file in a COLUMN instead of the bag.
   *
   * Two writes, one transaction-shaped pair: the row carries `field_id` (which
   * is what keeps it out of the bag and what survives a rename), and the id is
   * appended to `records.values[fieldId]`, which carries ORDER. That is the same
   * arrangement relations already use — `record_links` for membership,
   * `values[apiName]` for the chips a read projects — so this is the
   * established shape here rather than a new one.
   *
   * Order matters because the first file is the one a gallery card shows. "Which
   * one is the cover?" was the ticket's opening complaint; with an ordered field
   * the answer is "the first one in Cover", not "whichever you remember".
   */
  async upload(
    workspaceId: string,
    recordId: string,
    file: { filename: string; mime: string; data: Buffer },
    actorId: string,
    fieldId?: string,
    source: ChangeSource = 'human',
  ) {
    if (fieldId) await this.assertAttachmentField(recordId, fieldId);
    if (file.data.length > env().ATTACHMENT_MAX_BYTES) {
      throw new UnprocessableEntityException(
        `File exceeds the ${Math.round(env().ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB limit`,
      );
    }

    const storage = getStorage();
    const [row] = await this.db
      .insert(attachments)
      .values({
        recordId,
        fieldId: fieldId ?? null,
        filename: file.filename.slice(0, 255),
        size: file.data.length,
        mime: file.mime,
        storageKey: 'pending',
        uploadedBy: actorId,
      })
      .returning();

    const key = `${recordId}/${row!.id}/original`;
    await storage.put(key, file.data, file.mime);

    let thumbKey: string | null = null;
    if (file.mime.startsWith('image/') && file.mime !== 'image/svg+xml') {
      try {
        const thumb = await sharp(file.data).resize({ width: THUMB_WIDTH }).jpeg({ quality: 75 }).toBuffer();
        thumbKey = `${recordId}/${row!.id}/thumb`;
        await storage.put(thumbKey, thumb, 'image/jpeg');
      } catch {
        thumbKey = null; // corrupt/exotic image — the original still uploads fine
      }
    }

    const [updated] = await this.db
      .update(attachments)
      .set({ storageKey: key, thumbKey })
      .where(eq(attachments.id, row!.id))
      .returning();

    if (fieldId) await this.appendToField(workspaceId, recordId, fieldId, updated!.id, actorId);

    await this.db.insert(activityEvents).values({
      workspaceId,
      recordId,
      actorId,
      type: 'attachment.added',
      payload: { filename: file.filename, size: file.data.length, field_id: fieldId ?? null },
      source,
    });

    return {
      id: updated!.id,
      filename: updated!.filename,
      size: updated!.size,
      mime: updated!.mime,
      field_id: updated!.fieldId,
      has_thumbnail: Boolean(thumbKey),
      created_at: updated!.createdAt,
    };
  }

  /** The target must be an `attachment` field on THIS record's database. */
  private async assertAttachmentField(recordId: string, fieldId: string) {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (!record) throw new NotFoundException('Record not found');
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fields.id, fieldId), eq(fields.databaseId, record.databaseId), isNull(fields.deletedAt)),
    });
    // 404 rather than 422 for a field in ANOTHER database: whether that field
    // exists is not this caller's business.
    if (!field) throw new NotFoundException('Field not found');
    if (field.type !== 'attachment') {
      throw new UnprocessableEntityException(`Field "${field.displayName}" is not an attachment field`);
    }
  }

  /**
   * Append the new file to the end of the field's ordered list.
   *
   * Read-modify-write on a jsonb key, which is what every other value write in
   * this codebase does. Two uploads racing into the same field could lose one
   * id from the ORDER — the row itself is never lost, since `field_id` is the
   * membership record, so the recovery is a reorder rather than a missing file.
   */
  private async appendToField(
    workspaceId: string,
    recordId: string,
    fieldId: string,
    attachmentId: string,
    actorId: string,
  ) {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (!record) return;
    const values = { ...(record.values as Record<string, unknown>) };
    const current = Array.isArray(values[fieldId]) ? (values[fieldId] as string[]) : [];
    if (current.includes(attachmentId)) return;
    const next = [...current, attachmentId];
    values[fieldId] = next;
    await this.db.update(records).set({ values }).where(eq(records.id, recordId));
    // #671 — this write bypasses RecordsService.update() entirely (see that
    // method's own domain-event emission this mirrors), so without this a
    // rollup/pick-one targeting this field never hears about the change:
    // its materialized SORT KEY would go stale until something else
    // recomputes it. Fire-and-forget like every other domain-event emission —
    // never awaited, never on the critical path of the upload it followed.
    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId: record.databaseId,
      recordId,
      changedFieldIds: [fieldId],
      changedValues: { [fieldId]: { from: current, to: next } },
      actorId,
      depth: 0,
    });
  }

  async getRow(recordId: string, attachmentId: string) {
    const row = await this.db.query.attachments.findFirst({
      where: and(eq(attachments.id, attachmentId), eq(attachments.recordId, recordId)),
    });
    if (!row || row.storageKey === 'pending') throw new NotFoundException('Attachment not found');
    return row;
  }

  async stream(recordId: string, attachmentId: string, variant: 'original' | 'thumb') {
    const row = await this.getRow(recordId, attachmentId);
    const key = variant === 'thumb' ? row.thumbKey : row.storageKey;
    if (!key) throw new NotFoundException('No thumbnail for this attachment');
    return {
      stream: await getStorage().getStream(key),
      filename: row.filename,
      mime: variant === 'thumb' ? 'image/jpeg' : row.mime,
    };
  }

  /**
   * #599 — copy every attachment on `sourceRecordId` onto `targetRecordId`
   * (same database, via `RecordsService.duplicate()`). Each file's BYTES are
   * physically copied to a NEW storage key under the new record/attachment
   * id, never shared with the original's key: `remove()` above hard-deletes
   * both the DB row and its storage objects, so two attachment rows pointing
   * at the same key would mean deleting either one silently breaks the
   * other's file. `uploadedBy` is preserved from the source row (thread
   * history — who originally uploaded it — not the person who duplicated the
   * record); no `attachment.added` activity event is emitted, since the
   * event this generates for the new record is the duplication itself, not
   * N separate upload actions nobody performed.
   */
  async duplicateAll(
    workspaceId: string,
    sourceRecordId: string,
    targetRecordId: string,
    actorId: string,
  ): Promise<void> {
    const storage = getStorage();
    const rows = await this.db.query.attachments.findMany({
      where: eq(attachments.recordId, sourceRecordId),
      orderBy: [desc(attachments.createdAt)],
    });
    for (const row of rows) {
      const [created] = await this.db
        .insert(attachments)
        .values({
          recordId: targetRecordId,
          fieldId: row.fieldId,
          filename: row.filename,
          size: row.size,
          mime: row.mime,
          storageKey: 'pending',
          uploadedBy: row.uploadedBy,
        })
        .returning();

      const newKey = `${targetRecordId}/${created!.id}/original`;
      await storage.put(newKey, await streamToBuffer(await storage.getStream(row.storageKey)), row.mime);

      let newThumbKey: string | null = null;
      if (row.thumbKey) {
        newThumbKey = `${targetRecordId}/${created!.id}/thumb`;
        await storage.put(newThumbKey, await streamToBuffer(await storage.getStream(row.thumbKey)), 'image/jpeg');
      }

      await this.db
        .update(attachments)
        .set({ storageKey: newKey, thumbKey: newThumbKey })
        .where(eq(attachments.id, created!.id));

      if (row.fieldId) await this.appendToField(workspaceId, targetRecordId, row.fieldId, created!.id, actorId);
    }
  }

  /** Best-effort object deletion; record hard-deletes leave orphans for a future sweep (documented). */
  async remove(workspaceId: string, recordId: string, attachmentId: string, actorId: string) {
    const row = await this.getRow(recordId, attachmentId);
    // #391 — a field's value must not outlive the file it points at.
    if (row.fieldId) await this.detachFromField(workspaceId, recordId, row.fieldId, attachmentId, actorId);
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
    const storage = getStorage();
    await storage.delete(row.storageKey).catch(() => undefined);
    if (row.thumbKey) await storage.delete(row.thumbKey).catch(() => undefined);
    return { deleted: true };
  }

  private async detachFromField(
    workspaceId: string,
    recordId: string,
    fieldId: string,
    attachmentId: string,
    actorId: string,
  ) {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (!record) return;
    const values = { ...(record.values as Record<string, unknown>) };
    const current = Array.isArray(values[fieldId]) ? (values[fieldId] as string[]) : [];
    const next = current.filter((id) => id !== attachmentId);
    values[fieldId] = next;
    await this.db.update(records).set({ values }).where(eq(records.id, recordId));
    // #671 — same rollup/pick-one invalidation gap as appendToField's twin.
    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId: record.databaseId,
      recordId,
      changedFieldIds: [fieldId],
      changedValues: { [fieldId]: { from: current, to: next } },
      actorId,
      depth: 0,
    });
  }
}

