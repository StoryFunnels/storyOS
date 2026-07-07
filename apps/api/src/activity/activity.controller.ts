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
    await this.databases.get(req.membership, databaseId);
    await this.records.getRow(databaseId, recordId);
    return this.activityService.listForRecord(databaseId, recordId, query.limit, query.cursor);
  }
}
