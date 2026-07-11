import { BadRequestException, Controller, Get, Param, Post, Req, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { FilesService } from './files.service';

/** Upload endpoint — workspace-scoped + auth'd (MN-097). */
@ApiTags('files')
@ApiBearerAuth()
@Controller('workspaces/:ws/files')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an image for the editor (multipart "file"); returns { id, url }' })
  async upload(@Req() req: WorkspaceRequest) {
    const raw = req as unknown as FastifyRequest & {
      file?: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined>;
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
    return this.files.upload(req.membership.workspaceId, { filename: file.filename, mime: file.mimetype, data }, req.user.id);
  }
}

/** Serve endpoint — PUBLIC by unguessable id (capability URL), so embedded <img>
 * tags load without cookies/CORS. No auth guard by design. */
@ApiTags('files')
@Controller('files')
@SkipThrottle()
export class PublicFilesController {
  constructor(private readonly files: FilesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Serve an uploaded editor image by id (capability URL)' })
  async serve(@Param('id') id: string, @Res() reply: FastifyReply) {
    const { stream, mime } = await this.files.stream(id);
    reply.header('content-type', mime);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(stream);
  }
}
