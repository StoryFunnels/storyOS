import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { RecordsService } from '../records/records.service';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/attachments')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
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
  @ApiOperation({ summary: 'Attachments on a record' })
  async list(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    return this.attachmentsService.list(recordId);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file (multipart field "file"; size-capped)' })
  async upload(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'editor');
    const raw = req as unknown as FastifyRequest & {
      file?: () => Promise<
        { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined
      >;
    };
    if (typeof raw.file !== 'function') throw new BadRequestException('multipart body expected');
    const file = await raw.file();
    if (!file) throw new BadRequestException('multipart field "file" is required');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new UnprocessableEntityException('File exceeds the configured size limit');
    }

    return this.attachmentsService.upload(
      req.membership.workspaceId,
      recordId,
      { filename: file.filename, mime: file.mimetype, data },
      req.user.id,
    );
  }

  @Get(':att/download')
  @ApiOperation({ summary: 'Download the file (authz-checked, streamed)' })
  async download(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('att') attachmentId: string,
    @Res() reply: FastifyReply,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    const { stream, filename, mime } = await this.attachmentsService.stream(recordId, attachmentId, 'original');
    reply.header('content-type', mime);
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return reply.send(stream);
  }

  @Get(':att/thumbnail')
  @ApiOperation({ summary: 'Image thumbnail (404 for non-images)' })
  async thumbnail(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('att') attachmentId: string,
    @Res() reply: FastifyReply,
  ) {
    await this.assertRecord(req, databaseId, recordId);
    const { stream, mime } = await this.attachmentsService.stream(recordId, attachmentId, 'thumb');
    reply.header('content-type', mime);
    return reply.send(stream);
  }

  @Delete(':att')
  @ApiOperation({ summary: 'Delete an attachment (object removed best-effort)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Param('att') attachmentId: string,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'editor');
    return this.attachmentsService.remove(recordId, attachmentId);
  }
}
