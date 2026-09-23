import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { CopyRecordService } from './copy-record.service';

const copyRecordSchema = z.object({
  /**
   * #679 — #435's own AC3 promised a cap "enforced and stated in the UI
   * before mapping", and #612 found neither half built: nothing here capped
   * the selection at all. 200, not the 5000 batchUpdate/batchDelete allow
   * (record-values.ts's batchRecordIdsSchema) — deliberately lower, because
   * DryRunBuilder computes blocking-field checks EAGERLY across the WHOLE
   * selection before any chunking happens (see copy-record.service.ts), so
   * this operation's up-front cost scales differently from a simple batch
   * write. A rejection (not a silent truncation) — the same shape Otto has
   * already ruled on for #266/#433/#550/#653: a selection that silently
   * gets handled only in part is the dangerous outcome, not the missing
   * cap by itself.
   */
  record_ids: z.array(z.string()).min(1).max(200),
  target_database_id: z.string(),
  /** Source field api_names the caller explicitly skips — resolves a blocking field. */
  skip: z.array(z.string()).optional(),
  /** #605 — source field api_name -> destination field id, honored instead of
   *  the auto-matched destination (or a skip); also how an ambiguous relation
   *  is resolved by naming which candidate to use. */
  override: z.record(z.string(), z.string()).optional(),
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
        override: body.override,
        dryRun: body.dry_run,
      },
      req.user.id,
    );
  }
}
