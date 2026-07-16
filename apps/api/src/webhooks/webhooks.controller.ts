import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createWebhookSchema, updateWebhookSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { WebhooksService } from './webhooks.service';

class CreateWebhookDto extends createZodDto(createWebhookSchema) {}
class UpdateWebhookDto extends createZodDto(updateWebhookSchema) {}

/**
 * MN-032. Admin-only: a webhook holds a signing secret and makes the server send
 * outbound requests carrying record data, so it's a workspace-settings power, not
 * an editor one.
 */
@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @ApiOperation({ summary: 'List webhooks (secrets are never returned)' })
  async list(@Req() req: WorkspaceRequest) {
    return { data: await this.webhooks.list(req.membership.workspaceId) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a webhook — the signing secret is returned once, here only' })
  async create(@Req() req: WorkspaceRequest, @Body() body: CreateWebhookDto) {
    return this.webhooks.create(req.membership.workspaceId, body, req.user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook (url / events / enabled)' })
  async update(
    @Req() req: WorkspaceRequest,
    @Param('id') id: string,
    @Body() body: UpdateWebhookDto,
  ) {
    return this.webhooks.update(req.membership.workspaceId, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook' })
  async remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.webhooks.remove(req.membership.workspaceId, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Recent delivery attempts — status, code, error, retries' })
  async deliveries(
    @Req() req: WorkspaceRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    return { data: await this.webhooks.deliveries(req.membership.workspaceId, id, n) };
  }
}
