import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { user } from '../db/auth-schema';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { getStorage } from '../attachments/storage';

const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AVATAR_MAX_BYTES = 1024 * 1024; // client resizes to 256px; 1MB is generous

/** Content-Type from magic bytes — the storage driver keeps no metadata. */
function sniffMime(data: Buffer): string {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.length > 12 && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

/** User avatars (MN-045): upload/serve/remove through the storage driver. */
@ApiTags('users')
@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post('me/avatar')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Set my avatar (multipart field "file", png/jpeg/webp ≤1MB)' })
  async upload(@Req() req: AuthedRequest) {
    const raw = req as unknown as FastifyRequest & {
      file?: () => Promise<
        { mimetype: string; toBuffer: () => Promise<Buffer> } | undefined
      >;
    };
    if (typeof raw.file !== 'function') throw new BadRequestException('multipart body expected');
    const file = await raw.file();
    if (!file) throw new BadRequestException('multipart field "file" is required');
    if (!AVATAR_MIMES.has(file.mimetype)) {
      throw new UnprocessableEntityException('Avatar must be png, jpeg or webp');
    }
    const data = await file.toBuffer();
    if (data.length > AVATAR_MAX_BYTES) {
      throw new UnprocessableEntityException('Avatar too large (1MB max)');
    }
    await getStorage().put(`avatars/${req.user.id}`, data, file.mimetype);
    const url = `/api/v1/users/${req.user.id}/avatar?v=${Date.now()}`;
    await this.db.update(user).set({ image: url }).where(eq(user.id, req.user.id));
    return { image: url };
  }

  @Delete('me/avatar')
  @ApiOperation({ summary: 'Remove my avatar (falls back to initials)' })
  async remove(@Req() req: AuthedRequest) {
    await getStorage()
      .delete(`avatars/${req.user.id}`)
      .catch(() => undefined);
    await this.db.update(user).set({ image: null }).where(eq(user.id, req.user.id));
    return { image: null };
  }

  @Get(':id/avatar')
  @ApiOperation({ summary: 'Serve a user avatar (session required)' })
  async serve(@Param('id') id: string, @Res() reply: FastifyReply) {
    try {
      const stream = await getStorage().getStream(`avatars/${id}`);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks);
      void reply
        .header('content-type', sniffMime(data))
        .header('cache-control', 'private, max-age=86400')
        .send(data);
    } catch {
      throw new NotFoundException('No avatar');
    }
  }
}
