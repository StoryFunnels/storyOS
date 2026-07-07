import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, attachments } from '../db/schema';
import { env } from '../config/env';
import { getStorage } from './storage';

const THUMB_WIDTH = 320;

@Injectable()
export class AttachmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(recordId: string) {
    const rows = await this.db.query.attachments.findMany({
      where: eq(attachments.recordId, recordId),
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

  async upload(
    workspaceId: string,
    recordId: string,
    file: { filename: string; mime: string; data: Buffer },
    actorId: string,
  ) {
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

    await this.db.insert(activityEvents).values({
      workspaceId,
      recordId,
      actorId,
      type: 'attachment.added',
      payload: { filename: file.filename, size: file.data.length },
    });

    return {
      id: updated!.id,
      filename: updated!.filename,
      size: updated!.size,
      mime: updated!.mime,
      has_thumbnail: Boolean(thumbKey),
      created_at: updated!.createdAt,
    };
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
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
    const storage = getStorage();
    await storage.delete(row.storageKey).catch(() => undefined);
    if (row.thumbKey) await storage.delete(row.thumbKey).catch(() => undefined);
    return { deleted: true };
  }
}
