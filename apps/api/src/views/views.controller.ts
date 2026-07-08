import { Body, Controller, Delete, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createViewSchema, updateViewSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { ViewsService } from './views.service';

class CreateViewDto extends createZodDto(createViewSchema) {}
class UpdateViewDto extends createZodDto(updateViewSchema) {}

@ApiTags('views')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/views')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
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
}
