import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createViewSchema, updateViewSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { ViewsService } from './views.service';

class CreateViewDto extends createZodDto(createViewSchema) {}
class UpdateViewDto extends createZodDto(updateViewSchema) {}

// #520 — no folder_id: a personal view is never folder-placed (see
// ViewsService.create's ownerUserId branch).
const createPersonalViewSchema = createViewSchema.omit({ folder_id: true });
class CreatePersonalViewDto extends createZodDto(createPersonalViewSchema) {}

const shareViewSchema = z.object({
  visible_field_api_names: z.array(z.string()).optional(),
  include_relation_api_names: z.array(z.string()).optional(),
  indexable: z.boolean().optional(),
  // #535 — naming this turns the share into a recipient-scoped portal; see
  // ViewsService.share and PublicViewsService for the enforcement.
  recipient_scope_field_api_name: z.string().optional(),
});
class ShareViewDto extends createZodDto(shareViewSchema) {}

@ApiTags('views')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/views')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@RequiresScope('admin')
export class ViewsController {
  constructor(
    private readonly viewsService: ViewsService,
    private readonly databases: DatabasesService,
  ) {}

  /** Views are content, not schema: editors manage them (ADR-0007). */
  private async assertDb(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'editor');
  }

  @Post()
  @ApiOperation({ summary: 'Create a saved view (config validated against live fields)' })
  async create(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreateViewDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.create(databaseId, body, req.user.id);
  }

  /**
   * #520 — a personal view doesn't touch the shared schema, so it needs only
   * read access to the database, not editor (unlike `create` above). `write`
   * overrides the class's `admin` default — a personal view is the caller's
   * own content, not a schema/management change.
   */
  @Post('personal')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Create a view owned by me (private, never shared) over this database' })
  async createPersonal(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Body() body: CreatePersonalViewDto,
  ) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
    return this.viewsService.createPersonal(databaseId, body, req.user.id);
  }

  @Patch(':view')
  @ApiOperation({ summary: 'Rename / reconfigure / reorder a view' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
    @Body() body: UpdateViewDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.update(databaseId, viewId, body);
  }

  @Post(':view/duplicate')
  @ApiOperation({ summary: 'Duplicate a view with its full config, placed next to the original' })
  async duplicate(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.duplicate(databaseId, viewId);
  }

  @Post(':view/default')
  @ApiOperation({ summary: "Set this view as the database's default (one default per database)" })
  async setDefault(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.setDefault(databaseId, viewId);
  }

  @Delete(':view')
  @ApiOperation({ summary: 'Delete a view (409 on the last shared one)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    // #567 — unlike every other mutation here, delete's required access level
    // depends on WHICH view: the owner deleting their own personal view needs
    // only viewer (matching createPersonal), everything else still needs editor.
    const level = await this.viewsService.deleteAccessLevel(databaseId, viewId, req.user.id);
    await this.databases.assertAccess(req.membership, databaseId, level);
    return this.viewsService.remove(databaseId, viewId);
  }

  // #37 — no bare GET ':view' route exists on this controller, so there is no
  // ordering hazard with a literal 'trash' segment here (contrast
  // DatabasesController/WorkspacesController, which both have a wildcard
  // GET route this must be registered ahead of).
  @Get('trash')
  @ApiOperation({ summary: 'Deleted views on this database (editor+)' })
  async listTrash(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.assertDb(req, databaseId);
    return this.viewsService.listTrash(databaseId);
  }

  @Post(':view/restore')
  @ApiOperation({ summary: 'Restore a deleted view' })
  async restore(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.restore(databaseId, viewId);
  }

  @Post(':view/share')
  @ApiOperation({ summary: 'Publish a read-only public link for this view, or update its allowlist (#264)' })
  async share(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
    @Body() body: ShareViewDto,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.share(databaseId, viewId, body);
  }

  @Delete(':view/share')
  @ApiOperation({ summary: 'Revoke a view\'s public link — takes effect immediately (#264)' })
  async unshare(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.unshare(databaseId, viewId);
  }
}
