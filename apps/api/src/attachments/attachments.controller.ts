import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { RecordsService } from '../records/records.service';
import { AttachmentsService } from './attachments.service';

const attachFromUrlSchema = z.object({
  url: z.string().url().max(2000),
  filename: z.string().min(1).max(255).optional(),
  mime: z.string().min(1).max(200).optional(),
});
class AttachFromUrlDto extends createZodDto(attachFromUrlSchema) {}

@ApiTags('attachments')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec/attachments')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly records: RecordsService,
  ) {}

  /**
   * #473 AC2 — attachments are RECORD-scoped, not merely database-scoped.
   *
   * Previously: `DatabasesService.assertAccess` (database/space-level only)
   * plus `RecordsService.getRow` (existence only) — so a member with database
   * access could list/download/upload/delete attachments on ANY record in it,
   * even one a record-scoped grant (#472) deliberately did not extend to
   * them. `assertRecordAccess` is the same record-aware check the records
   * controller already uses for read/write of the record itself — reusing it
   * here means a record grant's boundary now actually reaches its files, not
   * just its field values.
   */
  private async assertRecord(
    req: WorkspaceRequest,
    databaseId: string,
    recordId: string,
    min: 'viewer' | 'editor' = 'viewer',
  ) {
    await this.records.assertRecordAccess(req.membership, databaseId, recordId, min);
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
  @ApiOperation({
    summary: 'Upload a file (multipart field "file"; size-capped). `?field=<id>` puts it in an attachment field instead of the record bag (#391)',
  })
  async upload(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Query('field') fieldId?: string,
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
      fieldId,
      req.auth?.source ?? 'human',
    );
  }

  /**
   * #1033 — attach a file the SERVER fetches from a URL. This used to happen inside the MCP process, with a bare `fetch` and no size cap:
   * an internal address (`http://api:3001/...`, the cloud metadata service, or a public URL that 302s to either) was fetched from inside
   * our network and the response handed back as a downloadable attachment. It now goes through the address-pinned guard, with every
   * redirect re-checked, a timeout, and the body capped while streaming at ATTACHMENT_MAX_BYTES.
   */
  @Post('from-url')
  @ApiOperation({
    summary: 'Attach a file the server fetches from a public URL (guarded: no private/metadata addresses, redirects re-checked, size-capped). `?field=<id>` as for upload',
  })
  async fromUrl(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('rec') recordId: string,
    @Body() body: AttachFromUrlDto,
    @Query('field') fieldId?: string,
  ) {
    await this.assertRecord(req, databaseId, recordId, 'editor');
    return this.attachmentsService.uploadFromUrl(
      req.membership.workspaceId,
      recordId,
      body,
      req.user.id,
      fieldId,
      req.auth?.source ?? 'human',
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
    return this.attachmentsService.remove(req.membership.workspaceId, recordId, attachmentId, req.user.id);
  }
}
