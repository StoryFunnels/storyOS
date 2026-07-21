import { Body, Controller, Delete, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { createConnectionSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ConnectionsService } from './connections.service';

class CreateConnectionDto extends createZodDto(createConnectionSchema) {}

/** 302 redirect via the raw Fastify reply (Nest passthrough is off under @Res) —
 * same helper as integrations.controller.ts's `redirect`. */
function redirect(reply: FastifyReply, url: string): void {
  void reply.header('location', url).code(302).send();
}

/**
 * MN-252 — the workspace credential registry. Any active member can see WHAT
 * is connected (never the credential); only an admin can add, remove, test or
 * start an OAuth connect — the same split webhooks.controller.ts and
 * automations.controller.ts use for workspace-settings-grade power.
 */
@ApiTags('connections')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({ summary: 'List connections (auth material is never returned)' })
  list(@Req() req: WorkspaceRequest) {
    return this.connections.list(req.membership.workspaceId);
  }

  @Get('providers')
  @RequiresScope('read')
  @ApiOperation({ summary: 'The provider catalog — what can be connected, and how' })
  providers() {
    return this.connections.listProviders();
  }

  @Post()
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Connect an api_key/smtp provider — runs a live health check before saving' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateConnectionDto) {
    return this.connections.create(req.membership.workspaceId, body, req.user.id);
  }

  @Delete(':id')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Disconnect — hard-deletes the row, no tombstone' })
  remove(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.connections.remove(req.membership.workspaceId, id);
  }

  @Post(':id/test')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Re-run the provider health check against the stored credential' })
  test(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.connections.test(req.membership.workspaceId, id);
  }

  @Get('oauth/:provider/start')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Begin an OAuth2 connect (redirects to the provider)' })
  start(@Req() req: WorkspaceRequest, @Param('provider') provider: string, @Res() reply: FastifyReply) {
    redirect(reply, this.connections.authorizeUrl(req.membership.workspaceId, provider, req.user.id));
  }
}
