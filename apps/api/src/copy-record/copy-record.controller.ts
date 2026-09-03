import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { CopyRecordService } from './copy-record.service';

const copyRecordSchema = z.object({
  record_ids: z.array(z.string()).min(1),
  target_database_id: z.string(),
  /** Source field api_names the caller explicitly skips — resolves a blocking field. */
  skip: z.array(z.string()).optional(),
  /** Default true: see the mapping + any blocking fields before committing anything. */
  dry_run: z.boolean().optional().default(true),
});
class CopyRecordDto extends createZodDto(copyRecordSchema) {}

/** #521 — copy one or more records from `:db` into another database. */
@ApiTags('records')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/copy')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class CopyRecordController {
  constructor(private readonly copyRecord: CopyRecordService) {}

  @Post()
  @ApiOperation({
    summary:
      'Copy records into another database (map -> dry-run -> apply). dry_run (default true) returns the field mapping and any blocking fields without writing anything.',
  })
  async copy(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: CopyRecordDto) {
    return this.copyRecord.run(
      req.membership,
      databaseId,
      {
        recordIds: body.record_ids,
        targetDatabaseId: body.target_database_id,
        skip: body.skip,
        dryRun: body.dry_run,
      },
      req.user.id,
    );
  }
}
