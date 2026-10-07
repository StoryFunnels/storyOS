import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaceGroups } from '../db/schema';

/**
 * #742 finding 04 — presentational-only tier above spaces (Otto's ruling,
 * 2026-09-24). Same shape as FoldersService by design; see the schema
 * comment on `spaceGroups` for why this is a table and not a column, and
 * for the tripwire this service must never cross.
 */
@Injectable()
export class GroupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async row(workspaceId: string, groupId: string) {
    const row = await this.db.query.spaceGroups.findFirst({
      where: and(eq(spaceGroups.id, groupId), eq(spaceGroups.workspaceId, workspaceId)),
    });
    if (!row) throw new NotFoundException('Group not found');
    return row;
  }

  async list(workspaceId: string) {
    const rows = await this.db.query.spaceGroups.findMany({
      where: eq(spaceGroups.workspaceId, workspaceId),
      orderBy: [asc(spaceGroups.position), asc(spaceGroups.createdAt)],
    });
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
  }

  async create(workspaceId: string, input: { name: string; color?: string }) {
    const [last] = await this.db
      .select({ position: spaceGroups.position })
      .from(spaceGroups)
      .where(eq(spaceGroups.workspaceId, workspaceId))
      .orderBy(desc(spaceGroups.position))
      .limit(1);
    const [row] = await this.db
      .insert(spaceGroups)
      .values({
        workspaceId,
        name: input.name.slice(0, 100),
        color: input.color,
        position: (last?.position ?? -1) + 1,
      })
      .returning();
    return { id: row!.id, name: row!.name, color: row!.color, position: row!.position };
  }

  async update(workspaceId: string, groupId: string, input: { name?: string; color?: string | null; position?: number }) {
    await this.row(workspaceId, groupId);
    const [row] = await this.db
      .update(spaceGroups)
      .set({ name: input.name?.slice(0, 100), color: input.color, position: input.position })
      .where(eq(spaceGroups.id, groupId))
      .returning();
    return { id: row!.id, name: row!.name, color: row!.color, position: row!.position };
  }

  /** Delete a group; its spaces fall back to ungrouped (FK set null). */
  async remove(workspaceId: string, groupId: string) {
    await this.row(workspaceId, groupId);
    await this.db.delete(spaceGroups).where(eq(spaceGroups.id, groupId));
    return { deleted: groupId };
  }
}
