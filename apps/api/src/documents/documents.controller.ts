import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
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
    );
  }
}
