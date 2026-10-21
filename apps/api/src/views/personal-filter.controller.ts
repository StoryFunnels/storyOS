import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { filterSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ViewerStateService } from '../viewer-state/viewer-state.service';

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
  constructor(private readonly viewerState: ViewerStateService) {}

  @Get()
  @ApiOperation({ summary: 'My personal filter override for this view (cleaned of dead field refs)' })
  async get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('view') viewId: string) {
    const filter = await this.viewerState.get(req.membership, 'view_filter', viewId, databaseId);
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
    const filter = await this.viewerState.set(req.membership, 'view_filter', viewId, body.filter, databaseId);
    return { filter: filter ?? null };
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my personal filter override for this view' })
  async clear(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Param('view') viewId: string) {
    await this.viewerState.clear(req.membership, 'view_filter', viewId, databaseId);
    return { cleared: true };
  }
}
