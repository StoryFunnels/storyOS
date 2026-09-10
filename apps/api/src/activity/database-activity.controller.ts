import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { ActivityService } from './activity.service';

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class ActivityQueryDto extends createZodDto(activityQuerySchema) {}

/**
 * #240 phase 1 — comments across a whole database, chronological. A separate
 * controller from ActivityController (which is scoped to ONE record) rather
 * than a second route on it: NestJS gives one base path per controller class,
 * and `records/:rec/activity` has no `:rec` segment for this to reuse.
 * Same read-only-by-design rule (ADR-0004): derived server-side, never
 * client-writable.
 */
@ApiTags('activity')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/activity')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DatabaseActivityController {
  constructor(
    private readonly activityService: ActivityService,
    private readonly databases: DatabasesService,
  ) {}

  @Get('comments')
  @ApiOperation({ summary: '#240 — comments across every record in this database, newest first (cursor)' })
  async listComments(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Query() query: ActivityQueryDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    return this.activityService.listCommentsForDatabase(databaseId, query.limit, query.cursor);
  }
}
