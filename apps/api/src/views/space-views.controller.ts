import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SpaceViewsService } from './space-views.service';

@ApiTags('views')
@ApiBearerAuth()
@Controller('workspaces/:ws')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class SpaceViewsController {
  constructor(private readonly spaceViews: SpaceViewsService) {}

  /**
   * #347 — the sidebar's one call per space. Deliberately NOT under
   * `/databases/:db/views`: the whole point is asking the question without
   * knowing which databases exist.
   */
  @Get('spaces/:space/views')
  @ApiOperation({ summary: "Views navigable in a space, for the sidebar tree (#347)" })
  async list(@Req() req: WorkspaceRequest, @Param('space') space: string) {
    return { data: await this.spaceViews.listForSpace(req.membership, space) };
  }
}
