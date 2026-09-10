import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { ActivityService } from './activity.service';

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class ActivityQueryDto extends createZodDto(activityQuerySchema) {}

/** #674 — a chain of relation field ids, one per level (Epic's own "Stories"
 *  field, then Story's own "Tasks" field, ...), comma-separated since this is
 *  a GET query param, not a body. */
const hierarchyQuerySchema = activityQuerySchema.extend({
  relation_field_ids: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});
class HierarchyQueryDto extends createZodDto(hierarchyQuerySchema) {}

/** Read-only by design: activity is derived server-side, never client-writable (ADR-0004). */
@ApiTags('activity')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/activity')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class ActivityController {
  constructor(
    private readonly activityService: ActivityService,
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Record activity trail, newest first (cursor)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query() query: ActivityQueryDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    await this.records.getRow(databaseId, recordId);
    return this.activityService.listForRecord(databaseId, recordId, query.limit, query.cursor);
  }

  /**
   * #674 — comments + references across a whole relation TREE rooted at this
   * record (Epic→Story→Task), not just this one record or one database.
   * Deliberately does NOT call `assertAccess`/`getRow` first: the service
   * itself resolves and permission-checks the root (and everything walked
   * from it) — a database-level `assertAccess` here would be the WRONG
   * check for a tree that legitimately spans multiple databases.
   */
  @Get('hierarchy')
  @ApiOperation({
    summary: '#674 — comments + references across a relation tree rooted at this record (e.g. Epic→Story→Task)',
  })
  async listHierarchy(
    @Req() req: WorkspaceRequest,
    @Param('rec') recordId: string,
    @Query() query: HierarchyQueryDto,
  ) {
    return this.activityService.listActivityForHierarchy(
      req.membership,
      recordId,
      query.relation_field_ids,
      query.limit,
      query.cursor,
    );
  }
}
