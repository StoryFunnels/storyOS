import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { SlackSubscriptionsService } from './slack-subscriptions.service';

const eventsSchema = z.array(z.enum(['created', 'status_changed', 'commented'])).min(1).max(3);

class CreateSlackSubscriptionDto extends createZodDto(
  z.object({
    /** Exactly one of space_id or database_id (the service rejects both and neither with a message). */
    space_id: z.uuid().optional(),
    database_id: z.uuid().optional(),
    /** A public channel's name or id. Leave empty when the workspace posts through an incoming webhook. */
    channel: z.string().max(100).optional(),
    events: eventsSchema,
    /** Required when the space or database is restricted: its record titles go to a channel StoryOS does not control. */
    acknowledge_restricted: z.boolean().optional(),
  }),
) {}

class UpdateSlackSubscriptionDto extends createZodDto(
  z.object({
    channel: z.string().max(100).nullable().optional(),
    events: eventsSchema.optional(),
    acknowledge_restricted: z.boolean().optional(),
  }),
) {}

/**
 * Ticket #1377 - Slack channel subscriptions. ADMIN-ONLY, like the Slack connection they post through and the other integration
 * settings (a member, and a guest above all, never even lists them: the list names databases and the channels their titles go to).
 *
 * Every route needs an admin-scoped token (#1049: an admin-role route does, GET included), which an agent's per-run credential (capped
 * at write) never has. An admin-scoped token an admin gave an agent may LIST (the MCP tool list_slack_subscriptions), so an agent can see
 * what posts where. Creating, changing and deleting have no MCP tool (packages/mcp coverage.ts): where a workspace's records go is a
 * person's call. The run-credential sweep (test/run-credential-outward-sweep.test.ts) proves the refusal for real.
 * Pointing a workspace's records at a Slack channel decides where its data goes, and that is a person's call.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/integrations/slack/subscriptions')
export class SlackSubscriptionsController {
  constructor(private readonly subscriptions: SlackSubscriptionsService) {}

  @Get() // #1049: an admin-role route needs an admin-scoped token, GET included
  @ApiOperation({ summary: 'List Slack channel subscriptions (which space or database posts to which channel, and how delivery is going)' })
  list(@Req() req: WorkspaceRequest) {
    return this.subscriptions.list(req.membership.workspaceId);
  }

  @Post()
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Subscribe a Slack channel to record created / status changed / comment added on a space or database' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateSlackSubscriptionDto) {
    return this.subscriptions.create(req.membership.workspaceId, req.user.id, body);
  }

  @Patch(':id')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Change a subscription’s events or channel; the admin who does it becomes its owner and a needs-attention flag clears' })
  update(@Req() req: WorkspaceRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSlackSubscriptionDto) {
    return this.subscriptions.update(req.membership.workspaceId, id, req.user.id, body);
  }

  @Delete(':id')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Remove a subscription: its posts stop' })
  remove(@Req() req: WorkspaceRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.remove(req.membership.workspaceId, id);
  }
}
