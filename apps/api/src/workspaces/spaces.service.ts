import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { normalizeIconInput } from '@storyos/schemas/icons';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { spaces } from '../db/schema';
import { AccessService } from '../access/access.service';
import { slugify } from '../databases/databases.service';
import type { Membership } from './workspace-access.guard';

@Injectable()
export class SpacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /** Guests see spaces they hold grants on — directly or via a database inside (ADR-0007). */
  async list(membership: Membership) {
    const visible = await this.access.visibleSpaceIds(membership);
    const scope =
      visible === null
        ? eq(spaces.workspaceId, membership.workspaceId)
        : visible.size > 0
          ? and(eq(spaces.workspaceId, membership.workspaceId), inArray(spaces.id, [...visible]))
          : and(eq(spaces.workspaceId, membership.workspaceId), inArray(spaces.id, ['00000000-0000-0000-0000-000000000000']));
    return this.db.query.spaces.findMany({ where: scope, orderBy: [asc(spaces.position)] });
  }

  /** Slug unique per workspace (MN-153) — namespaces the databases inside it. */
  private uniqueSpaceSlug(name: string, taken: Set<string>): string {
    const root = slugify(name) || 'space';
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async create(workspaceId: string, input: { name: string; icon?: string; color?: string }) {
    const existing = await this.db.query.spaces.findMany({
      where: eq(spaces.workspaceId, workspaceId),
    });
    const position = Math.max(-1, ...existing.map((s) => s.position)) + 1;
    const slug = this.uniqueSpaceSlug(input.name, new Set(existing.map((s) => s.slug)));
    // #283: never persist raw emoji — normalize through the same table the
    // one-time backfill (#251) uses, for every caller (HTTP API, templates,
    // integrations), not just requests that go through createSpaceSchema.
    const icon = normalizeIconInput(input.icon, input.name);
    const [space] = await this.db
      .insert(spaces)
      .values({ workspaceId, name: input.name, slug, icon, color: input.color, position })
      .returning();
    return space!;
  }

  async update(
    workspaceId: string,
    spaceId: string,
    patch: { name?: string; icon?: string | null; color?: string | null; position?: number },
  ) {
    let icon = patch.icon;
    if (icon !== undefined && icon !== null) {
      // Prefer the name in this same patch; otherwise the current row's name
      // powers inferIconFromName()'s fallback for emoji outside the table (#283).
      const name =
        patch.name ??
        (
          await this.db.query.spaces.findFirst({
            where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)),
            columns: { name: true },
          })
        )?.name ??
        '';
      icon = normalizeIconInput(icon, name) ?? icon;
    }
    const [space] = await this.db
      .update(spaces)
      .set({ ...patch, icon })
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
