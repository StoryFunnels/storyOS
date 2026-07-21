import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';

const versionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class VersionsQueryDto extends createZodDto(versionsQuerySchema) {}

/**
 * MN-231: read + restore for the per-record version snapshots captured by
 * RecordsService.update()/restoreVersion(). Sibling to ActivityController —
 * activity is "what changed", this is "what it looked like, and go back".
 */
@ApiTags('record-versions')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/versions')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class RecordVersionsController {
  constructor(
    private readonly records: RecordsService,
    private readonly databases: DatabasesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Record version history, newest first (cursor)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query() query: VersionsQueryDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    await this.records.getRow(databaseId, recordId);
    return this.records.listVersions(recordId, query.limit, query.cursor);
  }

  @Post(':version/restore')
  @ApiOperation({ summary: 'Restore the record to a previously captured version' })
  async restore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('version') versionId: string,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
    return this.records.restoreVersion(
      req.membership.workspaceId,
      databaseId,
      recordId,
      versionId,
      req.user.id,
    );
  }
}
