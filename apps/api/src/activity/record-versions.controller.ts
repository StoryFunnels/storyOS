import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
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
  constructor(private readonly records: RecordsService) {}

  @Get()
  @ApiOperation({ summary: 'Record version history, newest first (cursor)' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query() query: VersionsQueryDto,
  ) {
    // #474 phase 6 — was `assertAccess(db, 'viewer')` + `getRow` (existence
    // only): database-level, so a record-scoped-only guest's grant on a
    // DIFFERENT record in this database was enough to read this record's
    // full version history. assertRecordAccess folds existence + the
    // per-record check into the one call every other single-record read
    // route already uses.
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'viewer');
    return this.records.listVersions(recordId, query.limit, query.cursor);
  }

  /**
   * #31 (C2) — the field-level timeline. Deliberately a sibling route rather
   * than a shape change to GET /versions: that response is already consumed,
   * and these answer different questions (snapshots for restore vs per-field
   * events for reading).
   */
  @Get('changes')
  @ApiOperation({ summary: 'Per-field change history, newest first (cursor)' })
  async changes(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query() query: VersionsQueryDto,
  ) {
    // #474 phase 6 — same per-record fix as list() above.
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'viewer');
    return this.records.listFieldChanges(databaseId, recordId, query.limit, query.cursor);
  }

  /**
   * #39 — a single version's diff preview against the record's CURRENT
   * values, for the web UI's confirm-before-restoring dialog. Declared
   * AFTER the 'changes' route above: both are `@Get(<static-or-param>)` on
   * the same base path, and Nest matches in declaration order — a `:version`
   * route declared first would swallow `GET .../versions/changes` as if
   * "changes" were a version id.
   */
  @Get(':version')
  @ApiOperation({ summary: "A single version, as a diff preview against the record's current values" })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('version') versionId: string,
  ) {
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'viewer');
    return this.records.getVersion(databaseId, recordId, versionId);
  }

  @Post(':version/restore')
  @ApiOperation({ summary: 'Restore the record to a previously captured version' })
  async restore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('version') versionId: string,
  ) {
    // #474 phase 6 — was database-level only; a WRITE, so the per-record
    // gap mattered even more here than on the read routes above.
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, 'editor');
    return this.records.restoreVersion(
      req.membership.workspaceId,
      databaseId,
      recordId,
      versionId,
      req.user.id,
      req.auth?.source ?? 'human',
    );
  }
}
