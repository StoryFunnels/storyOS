import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { normalizeIconInput } from '@storyos/schemas/icons';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaceFolders } from '../db/schema';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/** Sidebar folders inside a space (MN-096) — manual grouping of databases/docs. */
@Injectable()
export class FoldersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * A folder by id, behind the SAME door as its space (#940). Folder names are as private as the space they sit in: this
   * used to check only that the folder was in the workspace, so a folder in someone's personal space could be read,
   * renamed and deleted by any member.
   */
  private async row(membership: Membership, folderId: string) {
    const row = await this.db.query.spaceFolders.findFirst({
      where: and(eq(spaceFolders.id, folderId), eq(spaceFolders.workspaceId, membership.workspaceId)),
    });
    if (!row) throw new NotFoundException('Folder not found');
    try {
      await this.access.assertSpaceDoor(membership, row.spaceId);
    } catch {
      throw new NotFoundException('Folder not found'); // same answer whether the folder or its space is the thing hidden
    }
    return row;
  }

  async list(membership: Membership, spaceId: string) {
    await this.access.assertSpaceDoor(membership, spaceId);
    const rows = await this.db.query.spaceFolders.findMany({
      where: eq(spaceFolders.spaceId, spaceId),
      orderBy: [asc(spaceFolders.position), asc(spaceFolders.createdAt)],
    });
    return rows.map((r) => ({ id: r.id, space_id: r.spaceId, name: r.name, icon: r.icon, position: r.position }));
  }

  async create(membership: Membership, spaceId: string, input: { name: string; icon?: string }) {
    const workspaceId = membership.workspaceId;
    await this.access.assertSpaceDoor(membership, spaceId);
    const [last] = await this.db
      .select({ position: spaceFolders.position })
      .from(spaceFolders)
      .where(eq(spaceFolders.spaceId, spaceId))
      .orderBy(desc(spaceFolders.position))
      .limit(1);
    // #283: normalize through the emoji migration table — folders.controller.ts
    // only enforces z.string().max(16), no `set:` requirement.
    const icon = normalizeIconInput(input.icon, input.name);
    const [row] = await this.db
      .insert(spaceFolders)
      .values({ workspaceId, spaceId, name: input.name.slice(0, 100), icon, position: (last?.position ?? -1) + 1 })
      .returning();
    return { id: row!.id, space_id: row!.spaceId, name: row!.name, icon: row!.icon, position: row!.position };
  }

  async update(membership: Membership, folderId: string, input: { name?: string; icon?: string | null; position?: number }) {
    const existing = await this.row(membership, folderId);
    let icon = input.icon;
    if (icon !== undefined && icon !== null) {
      icon = normalizeIconInput(icon, input.name ?? existing.name) ?? icon;
    }
    const [row] = await this.db
      .update(spaceFolders)
      .set({ name: input.name?.slice(0, 100), icon, position: input.position })
      .where(eq(spaceFolders.id, folderId))
      .returning();
    return { id: row!.id, space_id: row!.spaceId, name: row!.name, icon: row!.icon, position: row!.position };
  }

  /** Delete a folder; its databases/docs fall back to the space root (FK set null). */
  async remove(membership: Membership, folderId: string) {
    await this.row(membership, folderId);
    await this.db.delete(spaceFolders).where(eq(spaceFolders.id, folderId));
    return { deleted: folderId };
  }
}
