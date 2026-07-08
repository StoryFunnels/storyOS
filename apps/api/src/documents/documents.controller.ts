import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
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
    private readonly databases: DatabasesService,
    private readonly records: RecordsService,
  ) {}

  private async assertRecord(
    req: WorkspaceRequest,
    databaseId: string,
    recordId: string,
    min: 'viewer' | 'editor' = 'viewer',
  ) {
    await this.databases.assertAccess(req.membership, databaseId, min);
    await this.records.getRow(databaseId, recordId);
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
      recordId,
      body.content,
      body.expected_version,
      req.user.id,
    );
  }
}
