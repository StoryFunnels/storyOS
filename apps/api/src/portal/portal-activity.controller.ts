import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { PortalActivityService } from './portal-activity.service';

const portalActivityQuerySchema = z.object({
  recipient: z.uuid().optional(),
  view: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
class PortalActivityQueryDto extends createZodDto(portalActivityQuerySchema) {}

/**
 * #537 — "what each client actually saw and did", queryable per recipient
 * and/or per published view. Admin-only, matching `AuditLogController`
 * (#454) exactly — visible to workspace members who administer the portal,
 * never to recipients themselves (the ticket's own AC).
 */
@ApiTags('portal')
@ApiBearerAuth()
@Controller('workspaces/:ws/portal-activity')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
export class PortalActivityController {
  constructor(private readonly activity: PortalActivityService) {}

  @Get()
  @ApiOperation({ summary: 'Portal recipient activity — what a client saw and did, filterable by recipient/view (admin)' })
  list(@Req() req: WorkspaceRequest, @Query() query: PortalActivityQueryDto) {
    return this.activity.list(req.membership.workspaceId, query);
  }
}
