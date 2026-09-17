import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { RecordsService } from '../records/records.service';
import { DocumentsService } from './documents.service';

const putDocumentSchema = z.object({
  content: z.unknown(),
  /** 0 when creating; otherwise the version last read. */
  expected_version: z.number().int().min(0),
});
class PutDocumentDto extends createZodDto(putDocumentSchema) {}

const documentVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class DocumentVersionsQueryDto extends createZodDto(documentVersionsQuerySchema) {}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/document')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly records: RecordsService,
  ) {}

  // #474 phase 8 — was `databases.assertAccess(db, min)` + `getRow`
  // (existence only): database-level, so a record's BlockNote description
  // was readable/writable under DB-level access alone, the same gap
  // sections 5/6 had (and #473 already fixed for attachments.controller.ts —
  // this is the sibling `documents.controller.ts` the enumeration named as
  // sharing the identical pattern). assertRecordAccess folds existence + the
  // per-record check into the one call every other single-record route uses.
  private async assertRecord(
    req: WorkspaceRequest,
    databaseId: string,
    recordId: string,
    min: 'viewer' | 'editor' = 'viewer',
  ) {
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, min);
  }

  @Get()
  @ApiOperation({ summary: 'Record description (BlockNote JSON; version 0 = never written)' })
  async get(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    return this.documentsService.get(recordId);
  }

  @Put()
  @ApiOperation({ summary: 'Write the description — 409 with current version on conflict' })
  async put(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: PutDocumentDto,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'editor');
    return this.documentsService.put(
      req.membership.workspaceId,
      databaseId,
      recordId,
      body.content,
      body.expected_version,
      req.user.id,
      req.auth?.source ?? 'human',
      req.auth?.agentId,
      req.auth?.agentName,
    );
  }

  // #677 (Gap 2) — the document's own version history, sibling to
  // RecordVersionsController's routes over record_versions.

  @Get('versions')
  @ApiOperation({ summary: 'Document version history, newest first (cursor)' })
  async listVersions(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query() query: DocumentVersionsQueryDto,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    return this.documentsService.listVersions(recordId, query.limit, query.cursor);
  }

  @Get('versions/:version')
  @ApiOperation({ summary: 'A single document version, as a block-level diff preview against the current content' })
  async getVersion(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('version') versionId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    return this.documentsService.getVersion(recordId, versionId);
  }

  @Post('versions/:version/restore')
  @ApiOperation({ summary: 'Restore the document to a previously captured version' })
  async restoreVersion(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('version') versionId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'editor');
    return this.documentsService.restoreVersion(
      req.membership.workspaceId,
      recordId,
      versionId,
      req.user.id,
      req.auth?.source ?? 'human',
      req.auth?.agentId,
      req.auth?.agentName,
    );
  }
}
