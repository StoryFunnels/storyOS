import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { dismissedHintsSchema, pinnedTabsSchema } from './viewer-state.kinds';
import { ViewerStateService } from './viewer-state.service';

class SetPinnedTabsDto extends createZodDto(pinnedTabsSchema) {}
class SetDismissedHintsDto extends createZodDto(dismissedHintsSchema) {}

/**
 * My pinned view tabs for one database (ticket #986, the API half of #966). Like the personal filter this is a per-viewer override, not
 * shared config: any member who can see the database may set their own, so it needs only workspace membership plus the per-database
 * `viewer` check inside `ViewerStateService.reach` — not the admin gate `ViewsController` carries.
 */
@ApiTags('views')
@ApiBearerAuth()
@Controller('workspaces/:ws/databases/:db/pinned-tabs')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class PinnedTabsController {
  constructor(private readonly viewerState: ViewerStateService) {}

  @Get()
  @ApiOperation({ summary: 'My pinned view tabs for this database, in my order (views since trashed or no longer visible to me are left out)' })
  async get(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    const data = await this.viewerState.get(req.membership, 'pinned_tabs', databaseId);
    return { view_ids: data?.view_ids ?? [] };
  }

  @Put()
  @ApiOperation({ summary: 'Set (or replace) my pinned view tabs for this database: shared views, or my own personal views, in the order given' })
  async set(@Req() req: WorkspaceRequest, @Param('db') databaseId: string, @Body() body: SetPinnedTabsDto) {
    const data = await this.viewerState.set(req.membership, 'pinned_tabs', databaseId, body);
    return { view_ids: data.view_ids };
  }

  @Delete()
  @ApiOperation({ summary: 'Clear my pinned view tabs for this database' })
  async clear(@Req() req: WorkspaceRequest, @Param('db') databaseId: string) {
    await this.viewerState.clear(req.membership, 'pinned_tabs', databaseId);
    return { cleared: true };
  }
}

/**
 * The hints (one-time explainer cards) I have dismissed in this workspace (ticket #986, for #976). The target is the workspace in the
 * URL: membership is the whole access rule, because a dismissal hides a card from ME and touches nothing anyone else sees.
 */
@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces/:ws/dismissed-hints')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
export class DismissedHintsController {
  constructor(private readonly viewerState: ViewerStateService) {}

  @Get()
  @ApiOperation({ summary: 'The hints I have dismissed in this workspace' })
  async get(@Req() req: WorkspaceRequest, @Param('ws') workspaceId: string) {
    const data = await this.viewerState.get(req.membership, 'dismissed_hints', workspaceId);
    return { hint_ids: data?.hint_ids ?? [] };
  }

  @Put()
  @ApiOperation({ summary: 'Set (or replace) the list of hints I have dismissed in this workspace' })
  async set(@Req() req: WorkspaceRequest, @Param('ws') workspaceId: string, @Body() body: SetDismissedHintsDto) {
    const data = await this.viewerState.set(req.membership, 'dismissed_hints', workspaceId, body);
    return { hint_ids: data.hint_ids };
  }

  @Delete()
  @ApiOperation({ summary: 'Show every hint again: clear my dismissed list for this workspace' })
  async clear(@Req() req: WorkspaceRequest, @Param('ws') workspaceId: string) {
    await this.viewerState.clear(req.membership, 'dismissed_hints', workspaceId);
    return { cleared: true };
  }
}
