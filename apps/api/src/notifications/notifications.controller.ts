import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first' })
  list(
    @Req() req: WorkspaceRequest,
    @Query('unread_only') unreadOnly?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.list(
      req.membership.workspaceId,
      req.user.id,
      unreadOnly === 'true',
      cursor,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread badge count' })
  async unreadCount(@Req() req: WorkspaceRequest) {
    return { count: await this.notifications.unreadCount(req.membership.workspaceId, req.user.id) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.notifications.markRead(req.user.id, id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark everything read' })
  markAllRead(@Req() req: WorkspaceRequest) {
    return this.notifications.markAllRead(req.membership.workspaceId, req.user.id);
  }
}
