import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { normalizeIconInput } from '@storyos/schemas/icons';
import { normalizeDescription } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, spaces } from '../db/schema';
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
    // #291: another member's PERSONAL space never appears in the list — including for
    // admins. `visible === null` (admin/member "sees everything") is exactly the case
    // that would otherwise leak it, so the predicate is ANDed onto every branch.
    return this.db.query.spaces.findMany({
      where: and(scope, this.access.notOthersPersonal(membership)),
      orderBy: [asc(spaces.position)],
    });
  }

  /** Slug unique per workspace (MN-153) — namespaces the databases inside it. */
  private uniqueSpaceSlug(name: string, taken: Set<string>): string {
    const root = slugify(name) || 'space';
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async create(
    workspaceId: string,
    input: { name: string; icon?: string; color?: string; description?: string },
  ) {
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
      .values({
        workspaceId,
        name: input.name,
        slug,
        icon,
        color: input.color,
        // #400 — same choke-point reasoning as `icon` above: packs and templates
        // build spaces by calling this service, bypassing createSpaceSchema.
        description: normalizeDescription(input.description) ?? null,
        position,
      })
      .returning();
    return space!;
  }

  async update(
    workspaceId: string,
    spaceId: string,
    patch: {
      name?: string;
      icon?: string | null;
      color?: string | null;
      position?: number;
      description?: string | null;
    },
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
      .set({
        ...patch,
        icon,
        // Spread first, then override — a raw `patch.description` reaching the
        // column unnormalized is exactly the drift the service choke point exists
        // to prevent. Omitted keys stay omitted (`undefined` = leave alone).
        ...(patch.description !== undefined
          ? { description: normalizeDescription(patch.description) }
          : {}),
      })
      .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
      .returning();
    if (!space) throw new NotFoundException('Space not found');
    return space;
  }

  /**
   * #417 — the guard lives HERE, not in the UI.
   *
   * The sidebar refused to delete a non-empty space, so the founder's one-click
   * loss was an empty one — but that refusal was the ONLY protection anywhere,
   * and it was client-side. `DELETE /spaces/:space` cascaded unconditionally, so
   * MCP, a script or curl destroyed every database and record in the space with
   * no friction at all. A guard that only exists in one caller is not a guard;
   * it is a habit.
   *
   * `spaces → databases → records` is a hard-delete cascade. Records carry
   * `deletedAt` for the trash, but a cascade deletes the ROWS, so the trash
   * cannot recover any of it.
   *
   * Empty spaces confirm without a typed name deliberately — see
   * `deleteSpaceSchema`. Asking for ceremony where there is nothing to lose is
   * how people learn to type the name without reading the sentence.
   */
  async remove(workspaceId: string, spaceId: string, opts: { confirm?: string } = {}) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)),
      columns: { id: true, name: true },
    });
    if (!space) throw new NotFoundException('Space not found');

    const contained = await this.db.query.databases.findMany({
      where: eq(databases.spaceId, spaceId),
      columns: { id: true, name: true },
    });

    if (contained.length > 0 && opts.confirm !== space.name) {
      /*
       * The message states the blast radius rather than the rule. "confirm must
       * equal the name" tells someone what to type; naming the databases tells
       * them whether they should.
       */
      const names = contained.map((d) => d.name).join(', ');
      throw new UnprocessableEntityException(
        `Deleting "${space.name}" will permanently delete ${contained.length} database${
          contained.length === 1 ? '' : 's'
        } (${names}) and every record in them. This cannot be undone and the trash cannot recover it. ` +
          `To proceed, pass confirm: "${space.name}".`,
      );
    }

    const [gone] = await this.db
      .delete(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
      .returning();
    if (!gone) throw new NotFoundException('Space not found');
    return { deleted: true, databases_deleted: contained.length };
  }
}
