import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaces } from '../db/schema';
import type { Membership } from './workspace-access.guard';

@Injectable()
export class SpacesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Guests see only their scoped spaces (ADR-0006). */
  async list(membership: Membership) {
    const scope =
      membership.role === 'guest' && membership.spaceIds
        ? and(eq(spaces.workspaceId, membership.workspaceId), inArray(spaces.id, membership.spaceIds))
        : eq(spaces.workspaceId, membership.workspaceId);
    return this.db.query.spaces.findMany({ where: scope, orderBy: [asc(spaces.position)] });
  }

  async create(workspaceId: string, input: { name: string; icon?: string }) {
    const existing = await this.db.query.spaces.findMany({
      where: eq(spaces.workspaceId, workspaceId),
    });
    const position = Math.max(-1, ...existing.map((s) => s.position)) + 1;
    const [space] = await this.db
      .insert(spaces)
      .values({ workspaceId, name: input.name, icon: input.icon, position })
      .returning();
    return space!;
  }

  async update(
    workspaceId: string,
    spaceId: string,
    patch: { name?: string; icon?: string | null; position?: number },
  ) {
    const [space] = await this.db
      .update(spaces)
      .set(patch)
      .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
      .returning();
    if (!space) throw new NotFoundException('Space not found');
    return space;
  }

  async remove(workspaceId: string, spaceId: string) {
    const [gone] = await this.db
      .delete(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
      .returning();
    if (!gone) throw new NotFoundException('Space not found');
    return { deleted: true };
  }
}
