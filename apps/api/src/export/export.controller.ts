import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Readable } from 'node:stream';
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
    // Validate the db + view here (404s surface before any body goes out).
    const { databaseName, generate } = await this.exportService.prepareExport(
      databaseId,
      viewId,
      req.user.id,
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${csvFilename(databaseName, new Date())}"`);
    // Streamed (MN-128): the whole table, one page at a time, no row cap.
    return reply.send(Readable.from(generate()));
  }
}
