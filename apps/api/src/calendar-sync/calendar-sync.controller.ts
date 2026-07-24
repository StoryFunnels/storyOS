import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { CalendarSyncService } from './calendar-sync.service';

class CreateCalendarBindingDto extends createZodDto(
  z.object({
    connection_id: z.uuid(),
    database_id: z.uuid(),
    calendar_id: z.string().min(1).max(1024),
    calendar_name: z.string().min(1).max(500),
    start_field_id: z.uuid(),
    end_field_id: z.uuid().optional(),
    description_field_id: z.uuid().optional(),
    direction: z.enum(['push', 'pull', 'two_way']).default('push'),
  }),
) {}

@ApiTags('google-calendar')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/integrations/google-calendar')
export class CalendarSyncController {
  constructor(private readonly calendar: CalendarSyncService) {}

  @Get('calendars')
  @RequiresScope('read')
  @ApiOperation({ summary: 'List writable calendars for a Calendar connection' })
  calendars(@Req() req: WorkspaceRequest, @Query('connection_id') connectionId: string) {
    return this.calendar.listCalendars(req.membership.workspaceId, connectionId);
  }

  @Get('bindings')
  @RequiresScope('read')
  @ApiOperation({ summary: 'List database-to-calendar sync bindings' })
  bindings(@Req() req: WorkspaceRequest) {
    return this.calendar.listBindings(req.membership.workspaceId);
  }

  @Post('bindings')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Bind a database and date fields to a Google Calendar' })
  createBinding(@Req() req: WorkspaceRequest, @Body() body: CreateCalendarBindingDto) {
    return this.calendar.createBinding(req.membership.workspaceId, req.user.id, body);
  }

  @Post('bindings/:id/sync')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Push all current dated records to Google Calendar now' })
  sync(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.calendar.syncBinding(req.membership.workspaceId, id);
  }

  @Delete('bindings/:id')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Remove a calendar binding (existing Google events remain)' })
  remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.calendar.deleteBinding(req.membership.workspaceId, id);
  }
}
