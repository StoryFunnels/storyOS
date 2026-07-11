import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { workspaceFiles } from '../db/schema';
import { getStorage } from '../attachments/storage';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — editor images, not bulk file storage

/** Workspace-scoped uploads for rich-text editors (MN-097). Stored via the same
 * storage driver as attachments; served by unguessable id (capability URL) so
 * embedded <img> tags load without cookies/CORS in dev or prod. */
@Injectable()
export class FilesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upload(workspaceId: string, input: { filename: string; mime: string; data: Buffer }, actorId: string) {
    if (!input.mime.startsWith('image/')) {
      throw new UnprocessableEntityException('Only images can be embedded in the editor.');
    }
    if (input.data.length > MAX_BYTES) {
      throw new UnprocessableEntityException(`Image too large (${input.data.length} bytes; limit ${MAX_BYTES}).`);
    }
    const key = `editor/${workspaceId}/${randomUUID()}`;
    await getStorage().put(key, input.data, input.mime);
    const [row] = await this.db
      .insert(workspaceFiles)
      .values({ workspaceId, filename: input.filename.slice(0, 255), mime: input.mime, size: input.data.length, storageKey: key, uploadedBy: actorId })
      .returning();
    return { id: row!.id, url: `/api/v1/files/${row!.id}` };
  }

  async stream(id: string) {
    const row = await this.db.query.workspaceFiles.findFirst({ where: eq(workspaceFiles.id, id) });
    if (!row) throw new NotFoundException('File not found');
    return { stream: await getStorage().getStream(row.storageKey), mime: row.mime };
  }
}
