import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SpaceViewsService } from './space-views.service';

/**
 * #306 — a space-level view. `type` is validated in the service, not narrowed to
 * a literal here, so the rejection message can explain WHY a table needs a
 * database rather than the client seeing a bare enum error.
 */
const createSpaceViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(40),
  folder_id: z.string().uuid().nullable().optional(),
});
class CreateSpaceViewDto extends createZodDto(createSpaceViewSchema) {}

const updateSpaceViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.any().optional(),
  folder_id: z.string().uuid().nullable().optional(),
});
class UpdateSpaceViewDto extends createZodDto(updateSpaceViewSchema) {}

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

  /** #306 — create a dashboard that lives in the SPACE and owns no database. */
  @Post('spaces/:space/views')
  @ApiOperation({ summary: 'Create a space-level view — dashboards only (#306)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('space') space: string,
    @Body() body: CreateSpaceViewDto,
  ) {
    return this.spaceViews.createForSpace(req.membership, space, body, req.user.id);
  }

  /**
   * #306 — the view-first route. A view with no database cannot be addressed
   * under /databases/:db, and this resolves EITHER kind, so the existing
   * database-scoped URLs did not have to change.
   */
  @Get('views/:view')
  @ApiOperation({ summary: 'One view by id, with or without a database (#306)' })
  async get(@Req() req: WorkspaceRequest, @Param('view') view: string) {
    return this.spaceViews.getById(req.membership, view);
  }

  /**
   * #306 — move a database-level dashboard into its space. Separate from PATCH
   * because it is a MIGRATION, not a field edit: it rewrites tile config and
   * clears database_id together, and a caller must not be able to do half of it
   * by PATCHing database_id directly.
   */
  @Post('views/:view/move-to-space')
  @ApiOperation({ summary: 'Move a database-level dashboard into its space (#306)' })
  async moveToSpace(@Req() req: WorkspaceRequest, @Param('view') view: string) {
    return this.spaceViews.moveToSpace(req.membership, view);
  }

  /** #306 — update a view addressed without its database (a space dashboard). */
  @Patch('views/:view')
  @ApiOperation({ summary: 'Update a view by id — name / config / placement (#306)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('view') view: string,
    @Body() body: UpdateSpaceViewDto,
  ) {
    return this.spaceViews.updateById(req.membership, view, body);
  }
}
