import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { WorkspaceExportService } from './workspace-export.service';

/**
 * #320 — the owner's data-ownership hatch. Admin-only (like the other owner-level
 * workspace actions): a whole-workspace `.zip` with schema, records, relations and
 * attachments. Streamed, so a large workspace doesn't get buffered into memory.
 */
@ApiTags('export')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/export')
export class WorkspaceExportController {
  constructor(private readonly workspaceExport: WorkspaceExportService) {}

  @Get('workspace.zip')
  @RequiresScope('admin')
  @ApiOperation({
    summary: 'Download the whole workspace as a .zip (schema, records, relations, attachments)',
  })
  async workspace(@Req() req: WorkspaceRequest, @Res() reply: FastifyReply) {
    // Validate + build the (lazy) archive here; a bad workspace 404s before any
    // bytes go out, since the status can't change once the stream is flowing.
    const { filename, archive } = await this.workspaceExport.streamExport(
      req.membership.workspaceId,
    );
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return reply.send(archive);
  }
}
