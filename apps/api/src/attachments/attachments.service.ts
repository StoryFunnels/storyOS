import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, attachments, fields, records } from '../db/schema';
import { env } from '../config/env';
import { getStorage } from './storage';

const THUMB_WIDTH = 320;

@Injectable()
export class AttachmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

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

    if (fieldId) await this.appendToField(recordId, fieldId, updated!.id);

    await this.db.insert(activityEvents).values({
      workspaceId,
      recordId,
      actorId,
      type: 'attachment.added',
      payload: { filename: file.filename, size: file.data.length, field_id: fieldId ?? null },
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
  private async appendToField(recordId: string, fieldId: string, attachmentId: string) {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (!record) return;
    const values = { ...(record.values as Record<string, unknown>) };
    const current = Array.isArray(values[fieldId]) ? (values[fieldId] as string[]) : [];
    if (current.includes(attachmentId)) return;
    values[fieldId] = [...current, attachmentId];
    await this.db.update(records).set({ values }).where(eq(records.id, recordId));
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

  /** Best-effort object deletion; record hard-deletes leave orphans for a future sweep (documented). */
  async remove(recordId: string, attachmentId: string) {
    const row = await this.getRow(recordId, attachmentId);
    // #391 — a field's value must not outlive the file it points at.
    if (row.fieldId) await this.detachFromField(recordId, row.fieldId, attachmentId);
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
    const storage = getStorage();
    await storage.delete(row.storageKey).catch(() => undefined);
    if (row.thumbKey) await storage.delete(row.thumbKey).catch(() => undefined);
    return { deleted: true };
  }

  private async detachFromField(recordId: string, fieldId: string, attachmentId: string) {
    const record = await this.db.query.records.findFirst({ where: eq(records.id, recordId) });
    if (!record) return;
    const values = { ...(record.values as Record<string, unknown>) };
    const current = Array.isArray(values[fieldId]) ? (values[fieldId] as string[]) : [];
    values[fieldId] = current.filter((id) => id !== attachmentId);
    await this.db.update(records).set({ values }).where(eq(records.id, recordId));
  }
}

