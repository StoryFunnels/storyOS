import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { NotificationsService } from './notifications.service';
import type { NotificationType } from './notifications.service';

@ApiTags('notifications')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first (filter by type; archived view)' })
  list(
    @Req() req: WorkspaceRequest,
    @Query('unread_only') unreadOnly?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('archived') archived?: string,
  ) {
    const allowed = new Set([
      'assigned',
      'mentioned',
      'commented',
      'state_changed',
      // #210: filterable like any other type, though it is never opt-out-able.
      'approval_requested',
    ]);
    return this.notifications.list(req.membership.workspaceId, req.user.id, unreadOnly === 'true', cursor, {
      type: type && allowed.has(type) ? (type as NotificationType) : undefined,
      archived: archived === 'true',
    });
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

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive one notification (MN-073)' })
  archive(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.notifications.setArchived(req.user.id, id, true);
  }

  @Post(':id/unarchive')
  @ApiOperation({ summary: 'Restore an archived notification to the inbox' })
  unarchive(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.notifications.setArchived(req.user.id, id, false);
  }
}
