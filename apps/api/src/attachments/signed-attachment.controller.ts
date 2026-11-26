import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { isSafeImageMime } from '../files/image-sniff';
import { AttachmentsService } from './attachments.service';

/**
 * Ticket #51 — the signed, expiring read of one attachment image. UNAUTHENTICATED by design (Meta's servers fetch it):
 * the HMAC signature in the query proves it was minted here for this attachment and it dies after 15 minutes. Not
 * `@SkipThrottle()`: ordinary rate limiting is free defense against anyone fishing for a valid (id, expires, sig).
 * Same response hygiene as every file response (#1031): nosniff, a sandboxing CSP, and a stored type outside the raster
 * allowlist is never replayed as that type. Never cached.
 */
@ApiTags('attachments')
@Controller('attachments')
export class SignedAttachmentController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('signed/:id')
  @ApiOperation({ summary: 'Read one attachment image through a signed, expiring URL (used to hand an image to a network that publishes by fetching it)' })
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('expires') expires: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const { stream, mime } = await this.attachments.streamForSignedUrl(id, expires, sig);
    const safe = isSafeImageMime(mime);
    reply.header('content-type', safe ? mime : 'application/octet-stream');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    if (!safe) reply.header('content-disposition', 'attachment; filename="download"');
    reply.header('cache-control', 'private, no-store');
    return reply.send(stream);
  }
}
