import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, recordLinks, relations, selectOptions, spaces, views } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AccessService } from '../access/access.service';
import type { EffectiveRole } from '../access/access.service';
import { cleanViewConfig } from '../views/views.service';
import { presentFieldConfig } from '../common/webhook-headers';
import type { ViewConfig } from '@storyos/schemas';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'database'
  );
}

@Injectable()
export class DatabasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * Access-checked database load (ADR-0007): 404 without any grant, 403 below
   * `min`. The cheap primitive every content/schema controller calls.
   */
  async assertAccess(
    membership: Membership,
    databaseId: string,
    min: EffectiveRole,
  ): Promise<{ database: typeof databases.$inferSelect; my_access: EffectiveRole }> {
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, databaseId), eq(databases.workspaceId, membership.workspaceId)),
    });
    if (!database) throw new NotFoundException('Database not found');
    const effective = await this.access.effectiveForDatabase(membership, database);
    this.access.assertRank(effective, min, 'Database');
    return { database, my_access: effective! };
  }

  /**
   * MN-124: moving a database between spaces is a workspace-structure change.
   * This was a hand-rolled `if (role === 'guest')` in the controller — the only
   * role-string check outside the guards. It lives here so there is one place
   * that decides, and so the destination space is checked too: a guest with a
   * creator grant on a database must not re-parent it into a space they cannot see.
   */
  async assertCanMove(membership: Membership, destinationSpaceId?: string): Promise<void> {
    if (membership.role === 'guest') {
      throw new ForbiddenException('Moving databases requires membership');
    }
    if (destinationSpaceId) {
      await this.access.assertSpace(membership, destinationSpaceId, 'creator');
    }
  }

  /** Make `root` unique within a SPACE (MN-153), suffixing `_N` on collision. */
  private async uniqueSlugFor(spaceId: string, root: string): Promise<string> {
    const taken = new Set(
      (
        await this.db.query.databases.findMany({
          where: eq(databases.spaceId, spaceId),
          columns: { apiSlug: true },
        })
      ).map((d) => d.apiSlug),
    );
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}_${i + 1}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Slug unique within its SPACE, derived from the database name. */
  private uniqueSlug(spaceId: string, name: string): Promise<string> {
    return this.uniqueSlugFor(spaceId, slugify(name));
  }

  /** spaceId → slug for the workspace, to build qualified `space/database` refs. */
  private async spaceSlugs(workspaceId: string): Promise<Map<string, string>> {
    const rows = await this.db.query.spaces.findMany({
      where: eq(spaces.workspaceId, workspaceId),
      columns: { id: true, slug: true },
    });
    return new Map(rows.map((s) => [s.id, s.slug]));
  }

  async list(membership: Membership) {
    const visibility = await this.access.guestVisibility(membership);
    const rows = await this.db.query.databases.findMany({
      where: eq(databases.workspaceId, membership.workspaceId),
      orderBy: [asc(databases.position)],
    });
    const spaceSlugMap = await this.spaceSlugs(membership.workspaceId);
    const withRef = (d: (typeof rows)[number]) => {
      const spaceSlug = spaceSlugMap.get(d.spaceId) ?? null;
      return { ...d, spaceSlug, qualifiedSlug: spaceSlug ? `${spaceSlug}/${d.apiSlug}` : d.apiSlug };
    };
    if (!visibility) return rows.map(withRef);
    return rows
      .filter((d) => visibility.databaseIds.has(d.id) || visibility.spaceIds.has(d.spaceId))
      .map(withRef);
  }

  /** Full introspection payload: database + live fields + views + my_access (E4, ADR-0007). */
  async get(membership: Membership, databaseId: string) {
    const { database, my_access } = await this.assertAccess(membership, databaseId, 'viewer');

    const [fieldRows, viewRows] = await Promise.all([
      this.db.query.fields.findMany({
        where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
        orderBy: [asc(fields.position)],
      }),
      this.db.query.views.findMany({
        where: eq(views.databaseId, databaseId),
        orderBy: [asc(views.position)],
      }),
    ]);

    // Select options ride along so clients (table cells, MCP servers) can
    // render/validate without N+1 field fetches (E4 introspection).
    const selectFieldIds = fieldRows
      .filter((f) => f.type === 'select' || f.type === 'multi_select')
      .map((f) => f.id);
    const options = selectFieldIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectFieldIds),
          orderBy: [asc(selectOptions.position)],
        })
      : [];
    const optionsByField = new Map<string, typeof options>();
    for (const option of options) {
      const list = optionsByField.get(option.fieldId) ?? [];
      list.push(option);
      optionsByField.set(option.fieldId, list);
    }
    const fieldsWithOptions = fieldRows.map((f) =>
      optionsByField.has(f.id) ? { ...f, options: optionsByField.get(f.id) } : f,
    );

    // Relation fields carry enough metadata for generic clients to traverse
    // the graph (E4): target database, cardinality, inverse field.
    const relationIds = fieldRows
      .filter((f) => f.type === 'relation')
      .map((f) => (f.config as { relation_id?: string }).relation_id)
      .filter((id): id is string => Boolean(id));
    if (relationIds.length > 0) {
      const relationRows = await this.db.query.relations.findMany({
        where: inArray(relations.id, relationIds),
      });
      const targetIds = [
        ...new Set(relationRows.flatMap((r) => [r.databaseAId, r.databaseBId])),
      ];
      const targetDbs = await this.db.query.databases.findMany({
        where: inArray(databases.id, targetIds),
        columns: { id: true, name: true },
      });
      const dbName = new Map(targetDbs.map((d) => [d.id, d.name]));
      const byId = new Map(relationRows.map((r) => [r.id, r]));

      for (const field of fieldsWithOptions) {
        if (field.type !== 'relation') continue;
        const config = field.config as { relation_id: string; side: 'a' | 'b' };
        const relation = byId.get(config.relation_id);
        if (!relation) continue;
        const targetDatabaseId =
          config.side === 'a' ? relation.databaseBId : relation.databaseAId;
        (field as Record<string, unknown>).relation = {
          id: relation.id,
          cardinality: relation.cardinality,
          side: config.side,
          target_database_id: targetDatabaseId,
          target_database_name: dbName.get(targetDatabaseId) ?? null,
          inverse_field_id: config.side === 'a' ? relation.fieldBId : relation.fieldAId,
        };
      }
    }

    const liveIds = new Set(fieldRows.map((f) => f.id));
    const liveNames = new Set(fieldRows.map((f) => f.apiName));
    const cleanedViews = viewRows.map((v) => ({
      ...v,
      config: cleanViewConfig((v.config ?? {}) as ViewConfig, liveIds, liveNames),
    }));

    const space = await this.db.query.spaces.findFirst({
      where: eq(spaces.id, database.spaceId),
      columns: { slug: true },
    });
    const spaceSlug = space?.slug ?? null;
    return {
      ...database,
      spaceSlug,
      qualifiedSlug: spaceSlug ? `${spaceSlug}/${database.apiSlug}` : database.apiSlug,
      my_access,
      // A button field's config carries send_webhook headers; never surface a secret
      // header value in the introspection payload (any viewer can read this) (#249).
      fields: fieldsWithOptions.map((f) => ({ ...f, config: presentFieldConfig(f.config) })),
      views: cleanedViews,
    };
  }

  /** Creates the database + title/system fields + default table view, atomically (B2). */
  async create(
    membership: Membership,
    input: { space_id: string; name: string; icon?: string },
  ) {
    const space = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, input.space_id), eq(spaces.workspaceId, membership.workspaceId)),
    });
    if (!space) throw new NotFoundException('Space not found');

    const apiSlug = await this.uniqueSlug(input.space_id, input.name);
    const siblings = await this.db.query.databases.findMany({
      where: eq(databases.spaceId, input.space_id),
      columns: { position: true },
    });
    const position = Math.max(-1, ...siblings.map((d) => d.position)) + 1;

    return this.db.transaction(async (tx) => {
      const [database] = await tx
        .insert(databases)
        .values({
          workspaceId: membership.workspaceId,
          spaceId: input.space_id,
          name: input.name,
          icon: input.icon,
          apiSlug,
          position,
        })
        .returning();

      await tx.insert(fields).values([
        {
          databaseId: database!.id,
          displayName: 'ID',
          apiName: 'id',
          type: 'id',
          isSystem: true,
          position: -1, // renders before the title (MN-087)
        },
        {
          databaseId: database!.id,
          displayName: 'Name',
          apiName: 'name',
          type: 'title',
          position: 0,
        },
        {
          databaseId: database!.id,
          displayName: 'Created at',
          apiName: 'created_at',
          type: 'created_at',
          isSystem: true,
          position: 1000,
        },
        {
          databaseId: database!.id,
          displayName: 'Updated at',
          apiName: 'updated_at',
          type: 'updated_at',
          isSystem: true,
          position: 1001,
        },
        {
          databaseId: database!.id,
          displayName: 'Created by',
          apiName: 'created_by',
          type: 'created_by',
          isSystem: true,
          position: 1002,
        },
      ]);

      await tx.insert(views).values({
        databaseId: database!.id,
        name: 'All records',
        type: 'table',
        config: {},
        position: 0,
        isDefault: true,
      });

      return {
        ...database!,
        spaceSlug: space.slug,
        qualifiedSlug: `${space.slug}/${database!.apiSlug}`,
      };
    });
  }

  async update(
    membership: Membership,
    databaseId: string,
    patch: { name?: string; icon?: string | null; color?: string | null; space_id?: string; folder_id?: string | null; position?: number },
  ) {
    const current = await this.db.query.databases.findFirst({
      where: and(eq(databases.id, databaseId), eq(databases.workspaceId, membership.workspaceId)),
    });
    if (!current) throw new NotFoundException('Database not found');
    await this.get(membership, databaseId);

    // Moving to another space: keep the slug if free there, else suffix — the
    // per-space uniqueness (MN-153) would otherwise 500 on a collision.
    let apiSlug: string | undefined;
    if (patch.space_id && patch.space_id !== current.spaceId) {
      const space = await this.db.query.spaces.findFirst({
        where: and(eq(spaces.id, patch.space_id), eq(spaces.workspaceId, membership.workspaceId)),
      });
      if (!space) throw new NotFoundException('Target space not found');
      apiSlug = await this.uniqueSlugFor(patch.space_id, current.apiSlug);
    }

    const [updated] = await this.db
      .update(databases)
      .set({
        name: patch.name,
        icon: patch.icon,
        color: patch.color === null ? null : patch.color,
        spaceId: patch.space_id,
        apiSlug,
        folderId: patch.folder_id,
        position: patch.position,
      })
      .where(eq(databases.id, databaseId))
      .returning();
    return updated!;
  }

  /** Hard delete (v1 decision) — cascade wipes fields/records/views. */
  async remove(
    membership: Membership,
    databaseId: string,
    confirm: string,
    severRelations = false,
  ) {
    const database = await this.get(membership, databaseId);
    if (confirm !== database.name) {
      throw new ConflictException(`Confirmation mismatch: type the database name "${database.name}"`);
    }

    const touching = await this.db.query.relations.findMany({
      where: or(eq(relations.databaseAId, databaseId), eq(relations.databaseBId, databaseId)),
    });
    if (touching.length > 0 && !severRelations) {
      throw new ConflictException(
        `This database participates in ${touching.length} relation(s). Pass sever_relations: true to delete them along with it.`,
      );
    }

    await this.db.transaction(async (tx) => {
      if (touching.length > 0) {
        // Remove the paired fields living on OTHER databases (this db's own
        // fields cascade with the database row).
        const fieldIds = touching.flatMap((r) => [r.fieldAId, r.fieldBId]);
        await tx.delete(recordLinks).where(
          inArray(
            recordLinks.relationId,
            touching.map((r) => r.id),
          ),
        );
        await tx.delete(fields).where(inArray(fields.id, fieldIds));
        await tx.delete(relations).where(
          inArray(
            relations.id,
            touching.map((r) => r.id),
          ),
        );
      }
      await tx.delete(databases).where(eq(databases.id, databaseId));
    });
    return { deleted: true, severed_relations: touching.length };
  }
}
