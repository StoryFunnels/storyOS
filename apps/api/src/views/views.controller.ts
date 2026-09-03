import { Body, Controller, Delete, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
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

const shareViewSchema = z.object({
  visible_field_api_names: z.array(z.string()).optional(),
  include_relation_api_names: z.array(z.string()).optional(),
  indexable: z.boolean().optional(),
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
  @ApiOperation({ summary: 'Delete a view (409 on the last one)' })
  async remove(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
  ) {
    await this.assertDb(req, databaseId);
    return this.viewsService.remove(databaseId, viewId);
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
