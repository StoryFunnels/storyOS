import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { MentionsService } from './mentions.service';

const backlinksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
class BacklinksQueryDto extends createZodDto(backlinksQuerySchema) {}

@ApiTags('mentions')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/records/:rec')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class MentionsController {
  constructor(
    private readonly mentions: MentionsService,
    private readonly databases: DatabasesService,
  ) {}

  @Get('backlinks')
  @ApiOperation({ summary: 'Records whose document mentions this one ("Mentioned in") — MN-205, paged (#512)' })
  async backlinks(
    @Req() req: WorkspaceRequest,
    @Param('db') db: string,
    @Param('rec') rec: string,
    @Query() query: BacklinksQueryDto,
  ) {
    await this.databases.assertAccess(req.membership, db, 'viewer');
    return this.mentions.backlinks(req.membership, rec, { limit: query.limit, cursor: query.cursor });
  }
}
