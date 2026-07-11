import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaceFolders, spaces } from '../db/schema';

/** Sidebar folders inside a space (MN-096) — manual grouping of databases/docs. */
@Injectable()
export class FoldersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async assertSpace(workspaceId: string, spaceId: string) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)),
    });
    if (!space) throw new NotFoundException('Space not found');
  }

  private async row(workspaceId: string, folderId: string) {
    const row = await this.db.query.spaceFolders.findFirst({
      where: and(eq(spaceFolders.id, folderId), eq(spaceFolders.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Folder not found');
    return row;
  }

  async list(workspaceId: string, spaceId: string) {
    await this.assertSpace(workspaceId, spaceId);
    const rows = await this.db.query.spaceFolders.findMany({
      where: eq(spaceFolders.spaceId, spaceId),
      orderBy: [asc(spaceFolders.position), asc(spaceFolders.createdAt)],
    });
    return rows.map((r) => ({ id: r.id, space_id: r.spaceId, name: r.name, icon: r.icon, position: r.position }));
  }

  async create(workspaceId: string, spaceId: string, input: { name: string; icon?: string }) {
    await this.assertSpace(workspaceId, spaceId);
    const [last] = await this.db
      .select({ position: spaceFolders.position })
      .from(spaceFolders)
      .where(eq(spaceFolders.spaceId, spaceId))
      .orderBy(desc(spaceFolders.position))
      .limit(1);
    const [row] = await this.db
      .insert(spaceFolders)
      .values({ workspaceId, spaceId, name: input.name.slice(0, 100), icon: input.icon, position: (last?.position ?? -1) + 1 })
      .returning();
    return { id: row!.id, space_id: row!.spaceId, name: row!.name, icon: row!.icon, position: row!.position };
  }

  async update(workspaceId: string, folderId: string, input: { name?: string; icon?: string | null; position?: number }) {
    await this.row(workspaceId, folderId);
    const [row] = await this.db
      .update(spaceFolders)
      .set({ name: input.name?.slice(0, 100), icon: input.icon, position: input.position })
      .where(eq(spaceFolders.id, folderId))
      .returning();
    return { id: row!.id, space_id: row!.spaceId, name: row!.name, icon: row!.icon, position: row!.position };
  }

  /** Delete a folder; its databases/docs fall back to the space root (FK set null). */
  async remove(workspaceId: string, folderId: string) {
    await this.row(workspaceId, folderId);
    await this.db.delete(spaceFolders).where(eq(spaceFolders.id, folderId));
    return { deleted: folderId };
  }
}
