import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { filterSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { DatabasesService } from '../databases/databases.service';
import { PreferencesService } from '../users/preferences.service';

const setPersonalFilterSchema = z.object({ filter: filterSchema });
class SetPersonalFilterDto extends createZodDto(setPersonalFilterSchema) {}

/**
 * Personal filter override (#259): narrows a shared view's results for the
 * CURRENT viewer only, layered on top at query time (`{and:[shared, personal]}`)
 * — never touches the view's own ViewConfig, so nothing here mutates what other
 * members see.
 *
 * Deliberately a SEPARATE controller from ViewsController, not another route on
 * it: ViewsController is `@RequiresScope('admin')` + editor-minimum because a
 * view IS shared schema/config. A personal override isn't — any member who can
 * see the database may set their own (ticket #259 AC), so this only needs the
 * ordinary workspace-membership + per-database viewer check, not the admin gate.
 */
@ApiTags('views')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/views/:view/personal-filter')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class PersonalFilterController {
  constructor(
    private readonly databases: DatabasesService,
    private readonly preferences: PreferencesService,
  ) {}

  private async assertViewer(req: WorkspaceRequest, databaseId: string) {
    await this.databases.assertAccess(req.membership, databaseId, 'viewer');
  }

  @Get()
  @ApiOperation({ summary: 'My personal filter override for this view (cleaned of dead field refs)' })
  async get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('view') viewId: string) {
    await this.assertViewer(req, databaseId);
    const filter = await this.preferences.getViewFilter(req.user.id, databaseId, viewId);
    return { filter: filter ?? null };
  }

  @Put()
  @ApiOperation({ summary: 'Set (or replace) my personal filter override for this view' })
  async set(
    @Req() req: WorkspaceRequest,
    @Param('db') databaseId: string,
    @Param('view') viewId: string,
    @Body() body: SetPersonalFilterDto,
  ) {
    await this.assertViewer(req, databaseId);
    const filter = await this.preferences.setViewFilter(req.user.id, databaseId, viewId, body.filter);
    return { filter: filter ?? null };
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my personal filter override for this view' })
  async clear(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('view') viewId: string) {
    await this.assertViewer(req, databaseId);
    await this.preferences.clearViewFilter(req.user.id, databaseId, viewId);
    return { cleared: true };
  }
}
