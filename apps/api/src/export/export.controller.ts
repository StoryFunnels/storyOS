import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { ExportService } from './export.service';
import { csvFilename } from './csv';

/**
 * MN-075. Viewer-level: exporting shows you what you can already read, and the
 * per-database access check is the same one the table view runs.
 */
@ApiTags('export')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/databases/:db/export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly databases: DatabasesService,
  ) {}

  @Get('csv')
  @ApiOperation({ summary: 'Download the database (or a view) as CSV' })
  async csv(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Res() reply: FastifyReply,
    @Query('view') viewId?: string,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    const { csv, databaseName, truncated } = await this.exportService.exportCsv(
      databaseId,
      viewId,
      req.user.id,
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${csvFilename(databaseName, new Date())}"`);
    // For API/script consumers: a table past the row cap is cut off rather than
    // failed. The web UI downloads via a plain link and so can't read this — a
    // visible warning there needs the cap surfaced some other way (see MN-128).
    reply.header('x-storyos-truncated', truncated ? 'true' : 'false');
    return reply.send(csv);
  }
}
