import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
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

  /** #201: mint a short-lived signed download URL. Minting requires access to the
   * file's workspace (any active member — same "viewer+" bar as the inline path
   * gets under private-attachments mode); the resulting URL then carries its own
   * proof and needs no further auth. */
  @Post(':id/download-url')
  @ApiOperation({ summary: 'Mint a signed, expiring download URL for a file (#201)' })
  async mintDownloadUrl(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.files.mintDownloadUrl(req.membership.workspaceId, id);
  }

  /** #201: operator/owner revoke. A leaked capability URL or signed download URL
   * both stop working immediately; there is no un-revoke. Admin-only, matching
   * the bar other workspace-wide toggles use (e.g. webhook subscriptions). */
  @Post(':id/revoke')
  @MinRole('admin')
  @ApiOperation({ summary: 'Revoke a file — kills its capability URL and any signed download URLs (#201)' })
  async revoke(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.files.revoke(req.membership.workspaceId, id);
  }
}

/** Serve endpoint — capability URL by default, so embedded <img> tags load
 * without cookies/CORS. Requires auth + workspace-membership instead when the
 * owning workspace has private-attachments mode on (#201); see
 * FilesService.serveInline for the exact check. No guard on the controller
 * itself — the auth requirement is conditional on a per-workspace setting the
 * route doesn't know until it has read the file's row. */
@ApiTags('files')
@Controller('files')
@SkipThrottle()
export class PublicFilesController {
  constructor(private readonly files: FilesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Serve an uploaded editor image by id (capability URL, or access-checked under private-attachments mode)' })
  async serve(@Param('id') id: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const { stream, mime, cacheable } = await this.files.serveInline(id, req);
    reply.header('content-type', mime);
    reply.header(
      'cache-control',
      cacheable ? 'public, max-age=31536000, immutable' : 'private, no-store',
    );
    return reply.send(stream);
  }
}

/** #201: the signed-download endpoint, split from PublicFilesController so it is
 * NOT `@SkipThrottle()` — the signature is a 256-bit HMAC and not brute-forceable
 * in practice, but ordinary rate limiting is free defense in depth against an
 * attacker fishing for a valid (id, expires, sig) tuple. */
@ApiTags('files')
@Controller('files')
export class FileDownloadController {
  constructor(private readonly files: FilesService) {}

  @Get(':id/download')
  @ApiOperation({ summary: 'Download a file via a signed, expiring URL (#201)' })
  async download(
    @Param('id') id: string,
    @Query('expires') expires: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const { stream, mime, filename } = await this.files.streamForDownload(id, expires, sig);
    reply.header('content-type', mime);
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    // Short-TTL signed URL: never cache-immutable. no-store, not just no-cache —
    // this response is meaningfully different per signature/expiry pair and must
    // not be replayed from a shared cache after the file is revoked.
    reply.header('cache-control', 'private, no-store');
    return reply.send(stream);
  }
}
