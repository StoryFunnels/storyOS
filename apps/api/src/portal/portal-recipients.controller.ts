import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { createPortalRecipientSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { PortalRecipientsService } from './portal-recipients.service';

class CreatePortalRecipientDto extends createZodDto(createPortalRecipientSchema) {}

/**
 * #534 — admin-only, matching GrantsController: a portal recipient's token is
 * a standing credential to workspace content, same trust tier as a grant.
 */
@ApiTags('portal')
@ApiBearerAuth()
@Controller('workspaces/:ws/portal-recipients')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
export class PortalRecipientsController {
  constructor(private readonly recipients: PortalRecipientsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a portal recipient — never creates a user, never touches billable seats' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreatePortalRecipientDto) {
    return this.recipients.create(req.membership.workspaceId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List portal recipients for this workspace' })
  list(@Req() req: WorkspaceRequest) {
    return this.recipients.list(req.membership.workspaceId);
  }

  @Post(':recipient/revoke')
  @ApiOperation({ summary: 'Revoke a recipient — every access path closes immediately, no cache/TTL' })
  revoke(@Req() req: WorkspaceRequest, @Param('recipient') recipientId: string) {
    return this.recipients.revoke(req.membership.workspaceId, recipientId);
  }

  @Post(':recipient/rotate')
  @ApiOperation({ summary: 'Issue a new token for a recipient, atomically invalidating the old one (#602)' })
  rotate(@Req() req: WorkspaceRequest, @Param('recipient') recipientId: string) {
    return this.recipients.rotate(req.membership.workspaceId, recipientId);
  }
}
