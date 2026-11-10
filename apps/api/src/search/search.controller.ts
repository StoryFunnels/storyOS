import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ResourceScopable } from '../access/resource-scope';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, records, spaces } from '../db/schema';
import { notDeleted } from '../db/soft-delete';
import { AuthGuard } from '../auth/auth.guard';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';
import { MyWorkService } from './my-work.service';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';


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
    private readonly myWorkService: MyWorkService,
  ) {}

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

    // Ticket #1211 — a space result opens that space, so it must be one the caller can open: the sidebar DOOR
    // (`visibleSpaceIds`, never `assertSpace`) plus `notOthersPersonal`. This used to be "only when every database is
    // visible", which gave a guest (and a member in a restricted workspace) no space results at all, and let an admin's
    // search name ANOTHER member's personal space (private from admins, #291), a row that now opens a page.
    const visibleSpaces = await this.access.visibleSpaceIds(req.membership);
    let spaceRows: Array<{ id: string; name: string; icon: string | null }> = [];
    if (visibleSpaces === null || visibleSpaces.size > 0) {
      spaceRows = await this.db.query.spaces.findMany({
        where: and(
          eq(spaces.workspaceId, workspaceId),
          sql`${spaces.name} ILIKE ${pattern}`,
          notDeleted(spaces.deletedAt),
          this.access.notOthersPersonal(req.membership),
          ...(visibleSpaces !== null ? [inArray(spaces.id, [...visibleSpaces])] : []),
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
  @ApiOperation({
    summary:
      'My work: records assigned to me, created by me, assigned BY me, or waiting on me (approvals + unanswered mentions). Finished rows are dropped; every total is exact (MN-049, #36, #1250)',
  })
  @ApiQuery({ name: 'include_finished', required: false, description: 'true keeps Done/Canceled rows (the My work page renders them greyed out); default drops them.' })
  async myWork(
    @Req() req: WorkspaceRequest,
    @Query('tab') tab?: string,
    @Query('include_finished') includeFinished?: string,
  ) {
    // The ONE service the page, the MCP and the digest email share (#1250).
    if (tab === 'waiting') return this.myWorkService.waiting(req.membership, req.user.id);
    const mode = tab === 'created' ? 'created' : tab === 'assigned_by_me' ? 'assigned_by_me' : 'assigned';
    return this.myWorkService.recordSection(req.membership, req.user.id, mode, { includeFinished: includeFinished === 'true' });
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
