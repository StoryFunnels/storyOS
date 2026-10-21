import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ResourceScopable } from '../access/resource-scope';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, fields, records, selectOptions, spaces } from '../db/schema';
import { user } from '../db/auth-schema';
import { notDeleted } from '../db/soft-delete';
import { AuthGuard } from '../auth/auth.guard';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';

/** Field types worth rendering as a dense-row chip in My Work (MN-072). */
const DENSE_TYPES = new Set(['select', 'multi_select', 'workflow', 'user', 'relation', 'date', 'checkbox']);

/**
 * Global search (MN-048): title trigram over records + name matches on
 * databases/spaces, grant-scoped; plus per-user recents from activity.
 */
@ApiTags('search')
@ResourceScopable()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws')
export class SearchController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly recordsService: RecordsService,
  ) {}

  /**
   * #979 — for each record, who LAST set `userId` into one of its person fields, and when.
   *
   * Derived from the activity trail (`activity_events`, a `record.updated` event's `payload.diff`), not from a new column and not from
   * `record_field_changes`: that table is plan-gated (Free captures nothing, Pro keeps a day), so the answer would vanish on exactly the
   * workspaces most likely to ask. The activity trail is written for every update, has no pruning job today, and is indexed by
   * (record_id, created_at), so one query per database page (at most 50 records) reads it.
   *
   * An event counts when a person field's `to` CONTAINS the user and its `from` did not: the change that put them there, whether the
   * field holds one person or several. `DISTINCT ON (record_id) ... ORDER BY created_at DESC` is the LAST such change, so
   * A → B → me reports whoever set me, and me → removed → me again reports the second setter.
   *
   * No row means no change ever put the user there (the record was created with them set, was imported, or the trail predates the
   * assignment's capture): `null`, never a guess. The actor's name is what the record's own activity feed already shows to a caller who
   * can read the record, which every caller of this endpoint can for a row it returns.
   */
  private async assignedBy(
    recordIds: string[],
    userFieldIds: string[],
    userId: string,
  ): Promise<Map<string, { assigned_by: { id: string; name: string; kind: 'user' | 'agent' }; assigned_at: Date }>> {
    const out = new Map<string, { assigned_by: { id: string; name: string; kind: 'user' | 'agent' }; assigned_at: Date }>();
    if (recordIds.length === 0 || userFieldIds.length === 0) return out;
    const me = JSON.stringify(userId);
    const events = await this.db.execute<{
      record_id: string;
      actor_id: string | null;
      created_at: Date;
      source: string | null;
      agent_id: string | null;
      agent_name: string | null;
    }>(sql`
      SELECT DISTINCT ON (e.record_id) e.record_id, e.actor_id, e.created_at, e.source, e.agent_id, e.agent_name
      FROM activity_events e
      WHERE e.record_id IN (${sql.join(recordIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND e.type = 'record.updated'
        AND jsonb_typeof(e.payload->'diff') = 'object'
        AND EXISTS (
          SELECT 1 FROM jsonb_each(e.payload->'diff') d
          WHERE d.key IN (${sql.join(userFieldIds.map((id) => sql`${id}`), sql`, `)})
            AND (d.value->'to') @> ${me}::jsonb
            AND NOT COALESCE((d.value->'from') @> ${me}::jsonb, false)
        )
      ORDER BY e.record_id, e.created_at DESC, e.id DESC
    `);
    const rows = events.rows;
    const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id)))];
    const names = new Map(
      (actorIds.length ? await this.db.query.user.findMany({ where: inArray(user.id, actorIds), columns: { id: true, name: true } }) : []).map((a) => [a.id, a.name]),
    );
    for (const r of rows) {
      const agent = r.source === 'agent' || Boolean(r.agent_id);
      const by = agent
        ? { id: r.agent_id ?? r.actor_id ?? '', name: r.agent_name ?? names.get(r.actor_id ?? '') ?? '(agent)', kind: 'agent' as const }
        : r.actor_id
          ? { id: r.actor_id, name: names.get(r.actor_id) ?? '(deactivated)', kind: 'user' as const }
          : null;
      if (by) out.set(r.record_id, { assigned_by: by, assigned_at: new Date(r.created_at) });
    }
    return out;
  }

  /** Renderable field metadata for a database's dense My Work rows (MN-072). */
  private async denseFields(databaseId: string) {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      orderBy: (f, { asc }) => [asc(f.position)],
    });
    const dense = fieldRows.filter((f) => DENSE_TYPES.has(f.type));
    const selectIds = dense.filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow').map((f) => f.id);
    const opts = selectIds.length
      ? await this.db.query.selectOptions.findMany({ where: inArray(selectOptions.fieldId, selectIds) })
      : [];
    const byField = new Map<string, Array<{ id: string; label: string; color: string }>>();
    for (const o of opts) {
      const list = byField.get(o.fieldId) ?? [];
      list.push({ id: o.id, label: o.label, color: o.color });
      byField.set(o.fieldId, list);
    }
    return dense.map((f) => ({
      id: f.id,
      api_name: f.apiName,
      display_name: f.displayName,
      type: f.type,
      options: byField.get(f.id) ?? undefined,
    }));
  }

  /**
   * Databases the caller may see, or null for members/admins (= all).
   *
   * #469 — this used to compute the guest/space/database intersection inline,
   * a second copy of the same logic mentions.service.ts also carried inline.
   * Both now go through AccessService.visibleDatabaseIds.
   */
  private async visibleDatabaseIds(req: WorkspaceRequest): Promise<string[] | null> {
    const ids = await this.access.visibleDatabaseIds(req.membership);
    return ids === null ? null : [...ids];
  }

  @Get('search')
  @ApiOperation({ summary: 'Search records by title + databases/spaces by name (grant-scoped)' })
  async search(@Req() req: WorkspaceRequest, @Query('q') q?: string) {
    const query = (q ?? '').trim();
    if (!query) return { records: [], places: [] };
    const workspaceId = req.membership.workspaceId;
    const visible = await this.visibleDatabaseIds(req);
    // #474 phase 4 — a record-scoped grant (#472) names one record, not a
    // whole database: OR'd in alongside `visible` below so that record is
    // findable without widening the whole database into scope.
    const recordGrantIds = await this.access.guestRecordGrantIds(req.membership);
    const hasRecordGrants = Boolean(recordGrantIds?.size);
    if (visible !== null && visible.length === 0 && !hasRecordGrants) return { records: [], places: [] };

    // LIKE metacharacters must be neutralised for both the match and the ranking
    // predicates below — a title containing "%" must not turn into a wildcard.
    const escaped = query.replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    // #884 — for a guest, the title of a record whose computed title carries data they cannot read is its LOCAL title,
    // for the match, the ranking, the length tiebreak AND what is returned: matching the stored text would let a search
    // for a hidden substring find the record.
    const titleCol = (await this.recordsService.titleSqlForWorkspace(req.membership, workspaceId)) ?? sql`${records.title}`;
    const recordRows = await this.db
      .select({
        id: records.id,
        // Per-database sequential id — rendered as the faint #<number> in pickers
        // (#227/#228 record-chip style), so a #mention reads "#12 Title".
        number: records.number,
        title: sql<string>`${titleCol}`,
        database_id: records.databaseId,
        database_name: databases.name,
        database_icon: databases.icon,
        // #178: the owning database's colour (for the DbColorMarker cylinder) and
        // its space name (for the `space › database` breadcrumb) so a picker row
        // reads exactly like a relation chip without a follow-up fetch.
        database_color: databases.color,
        space_name: spaces.name,
        updated_at: records.updatedAt,
      })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(
        and(
          eq(databases.workspaceId, workspaceId),
          isNull(records.deletedAt),
          sql`${titleCol} ILIKE ${pattern}`,
          ...(visible !== null
            ? [
                or(
                  visible.length ? inArray(records.databaseId, visible) : sql`false`,
                  hasRecordGrants ? inArray(records.id, [...recordGrantIds!]) : sql`false`,
                ),
              ]
            : []),
        ),
      )
      // #252 — rank by RELEVANCE, not just recency: an exact title match beats a
      // prefix match, which beats a match at a word boundary ("plan" matching
      // "Launch plan"), which beats a bare substring ("plan" in "Unplanned").
      // Recency only breaks ties inside a tier, so typing a title you know lands
      // it first instead of burying it under whatever you touched most recently.
      .orderBy(
        sql`CASE
              WHEN lower(${titleCol}) = lower(${query}) THEN 0
              WHEN ${titleCol} ILIKE ${escaped + '%'} THEN 1
              WHEN ${titleCol} ILIKE ${'% ' + escaped + '%'} THEN 2
              ELSE 3
            END`,
        // Shorter titles are the tighter match at the same tier ("Plan" over
        // "Plan the offsite roadshow") — then most-recently-updated.
        sql`length(${titleCol})`,
        desc(records.updatedAt),
      )
      .limit(15);

    const databaseRows = await this.db
      .select({
        id: databases.id,
        name: databases.name,
        icon: databases.icon,
        // #516 — the same #178 enrichment recordRows already carries (the owning
        // space's name + the database's colour), so two same-named databases in
        // different spaces read distinctly instead of two identical "Database" rows.
        database_color: databases.color,
        space_name: spaces.name,
      })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(
        and(
          eq(databases.workspaceId, workspaceId),
          sql`${databases.name} ILIKE ${pattern}`,
          notDeleted(databases.deletedAt),
          ...(visible !== null ? [inArray(databases.id, visible)] : []),
        ),
      )
      .limit(5);

    let spaceRows: Array<{ id: string; name: string; icon: string | null }> = [];
    if (visible === null) {
      spaceRows = await this.db.query.spaces.findMany({
        where: and(
          eq(spaces.workspaceId, workspaceId),
          sql`${spaces.name} ILIKE ${pattern}`,
          notDeleted(spaces.deletedAt),
        ),
        columns: { id: true, name: true, icon: true },
        limit: 5,
      });
    }

    return {
      // #178: `type` is the entity discriminator every record row carries — coarse
      // today (all hits are records), it lets the picker filter by kind and stays
      // consistent with /recent below.
      records: recordRows.map((r) => ({ ...r, type: 'record' as const })),
      places: [
        ...databaseRows.map((d) => ({ kind: 'database' as const, ...d })),
        ...spaceRows.map((s) => ({ kind: 'space' as const, ...s })),
      ],
    };
  }

  @Get('my-work')
  @ApiOperation({ summary: 'Records across databases assigned to me or created by me (MN-049, #36)' })
  async myWork(@Req() req: WorkspaceRequest, @Query('tab') tab?: string) {
    const mode = tab === 'created' ? 'created' : 'assigned';
    // #474 phase 4 — `visibleDatabaseIds` alone would skip a database where
    // the guest's only access is a record-scoped grant (#472), the same gap
    // phase 3 closed for relation chips. `reachableDatabaseIds` widens which
    // databases are even considered; `visibleRecordIds` per database below
    // then narrows which ROWS within a record-scoped-only one are visible.
    const reachable = await this.access.reachableDatabaseIds(req.membership);
    if (reachable !== null && reachable.size === 0) return { groups: [] };

    const dbRows = await this.db.query.databases.findMany({
      where: and(
        eq(databases.workspaceId, req.membership.workspaceId),
        notDeleted(databases.deletedAt),
        ...(reachable !== null ? [inArray(databases.id, [...reachable])] : []),
      ),
      columns: { id: true, name: true, icon: true, color: true, spaceId: true },
    });

    const groups: Array<{
      database: { id: string; name: string; icon: string | null; color: string | null };
      fields: Awaited<ReturnType<SearchController['denseFields']>>;
      records: Array<{
        id: string;
        title: string;
        number: number | null;
        updated_at: Date;
        values: Record<string, unknown>;
        /** #979 — who last set the caller into a person field of this record, or null (see `assignedBy`). */
        assigned_by: { id: string; name: string; kind: 'user' | 'agent' } | null;
        assigned_at: Date | null;
      }>;
    }> = [];
    for (const database of dbRows) {
      let predicate;
      let userFieldIds: string[] = [];
      if (mode === 'created') {
        predicate = eq(records.createdBy, req.user.id);
      } else {
        const userFields = await this.db.query.fields.findMany({
          where: and(eq(fields.databaseId, database.id), eq(fields.type, 'user'), isNull(fields.deletedAt)),
          columns: { id: true },
        });
        if (userFields.length === 0) continue;
        userFieldIds = userFields.map((f) => f.id);
        predicate = or(...userFields.map((f) => sql`${records.values}->${f.id} ? ${req.user.id}`));
      }
      // #474 phase 4 — this database may be reachable ONLY via a
      // record-scoped grant (reachableDatabaseIds widened the set above);
      // visibleRecordIds narrows to exactly the granted rows in that case,
      // and stays null (no extra filter) for a fully-visible database.
      const recordScope = reachable !== null ? await this.access.visibleRecordIds(req.membership, database) : null;
      if (recordScope && recordScope.ids.size === 0) continue;

      // Full rows so we can project values (status/priority/assignee/…) for dense rows (MN-072).
      const rows = await this.db.query.records.findMany({
        where: and(
          eq(records.databaseId, database.id),
          isNull(records.deletedAt),
          predicate,
          ...(recordScope ? [inArray(records.id, [...recordScope.ids])] : []),
        ),
        orderBy: [desc(records.updatedAt)],
        limit: 50,
      });
      if (rows.length === 0) continue;

      const defs = await this.recordsService.fieldDefs(database.id);
      const projected = await this.recordsService.attachLinks(
        rows.map((r) => this.recordsService.project(r, defs)),
        defs,
        req.membership,
      );
      const byId = new Map(projected.map((p) => [p.id, p]));
      // #979 — who set me, and when (assigned tab only; the created tab has no assignment to explain). null = see `assignedBy`.
      const assigned = mode === 'assigned' ? await this.assignedBy(rows.map((r) => r.id), userFieldIds, req.user.id) : new Map();
      groups.push({
        database: { id: database.id, name: database.name, icon: database.icon, color: database.color },
        fields: await this.denseFields(database.id),
        // #884 — attachLinks narrowed the PROJECTED titles; this row shape reads the stored title, so use theirs.
        records: rows.map((r) => ({
          id: r.id,
          title: byId.get(r.id)?.title ?? r.title,
          number: r.number,
          updated_at: r.updatedAt,
          values: byId.get(r.id)?.values ?? {},
          assigned_by: assigned.get(r.id)?.assigned_by ?? null,
          assigned_at: assigned.get(r.id)?.assigned_at ?? null,
        })),
      });
    }
    return { groups };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Records the caller touched most recently (from activity)' })
  async recent(@Req() req: WorkspaceRequest) {
    const visible = await this.visibleDatabaseIds(req);
    // #474 phase 4 — same OR-in-the-record-grant treatment as /search: a
    // record-scoped grant (#472) names one record, not a whole database.
    const recordGrantIds = await this.access.guestRecordGrantIds(req.membership);
    const hasRecordGrants = Boolean(recordGrantIds?.size);
    if (visible !== null && visible.length === 0 && !hasRecordGrants) return { records: [] };

    const rows = await this.db
      .select({
        record_id: activityEvents.recordId,
        last: sql<string>`max(${activityEvents.createdAt})`,
      })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, req.membership.workspaceId),
          eq(activityEvents.actorId, req.user.id),
        ),
      )
      .groupBy(activityEvents.recordId)
      .orderBy(desc(sql`max(${activityEvents.createdAt})`))
      .limit(20);

    const ids = rows.map((r) => r.record_id).filter((v): v is string => Boolean(v));
    if (ids.length === 0) return { records: [] };
    const recent = await this.db
      .select({
        id: records.id,
        number: records.number,
        title: records.title,
        database_id: records.databaseId,
        database_name: databases.name,
        database_icon: databases.icon,
        // #178: same enrichment as /search so recents render an identical row —
        // db colour marker + `space › database` breadcrumb.
        database_color: databases.color,
        space_name: spaces.name,
      })
      .from(records)
      .innerJoin(databases, eq(databases.id, records.databaseId))
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(
        and(
          inArray(records.id, ids),
          isNull(records.deletedAt),
          ...(visible !== null
            ? [
                or(
                  visible.length ? inArray(records.databaseId, visible) : sql`false`,
                  hasRecordGrants ? inArray(records.id, [...recordGrantIds!]) : sql`false`,
                ),
              ]
            : []),
        ),
      )
      .limit(10);
    const order = new Map(ids.map((id, i) => [id, i]));
    recent.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    const out = recent.slice(0, 10).map((r) => ({ ...r, type: 'record' as const }));
    await this.recordsService.narrowTitles(req.membership, out); // #884
    return { records: out };
  }
}
