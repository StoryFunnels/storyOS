import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { createConnectionSchema, updateConnectionSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import { NoRunCredential, RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { ConnectionsService } from './connections.service';
import { SocialAccountsService } from './social-accounts.service';
import { nonceCookie } from './oauth-nonce-cookie';

class CreateConnectionDto extends createZodDto(createConnectionSchema) {}
class UpdateConnectionDto extends createZodDto(updateConnectionSchema) {}
/** `refresh=true` skips the few-minute cache of the page list. */
class SocialAccountsQueryDto extends createZodDto(z.object({ refresh: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })) {}

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
  constructor(
    private readonly connections: ConnectionsService,
    private readonly social: SocialAccountsService,
  ) {}

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

  // An agent run's credential must not enumerate accounts through a stored connection credential: this calls the network LIVE.
  @Get(':id/social-accounts')
  @RequiresScope('read')
  @NoRunCredential()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The accounts a LinkedIn or X connection can post as (profile, company pages, X account): the picker a post names its account from. Workspace admin or the person who connected it. Cached a few minutes; refresh=true asks the network again.',
  })
  socialAccounts(@Req() req: WorkspaceRequest, @Param('id') id: string, @Query() query: SocialAccountsQueryDto) {
    return this.social.list(req.membership, req.user.id, id, query.refresh);
  }

  @Post()
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Connect an api_key/smtp provider — runs a live health check before saving' })
  create(@Req() req: WorkspaceRequest, @Body() body: CreateConnectionDto) {
    return this.connections.create(req.membership.workspaceId, body, req.user.id);
  }

  @Patch(':id')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Set the one URL prefix an HTTP connection\'s credential may be sent to (#1035)' })
  update(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: UpdateConnectionDto) {
    return this.connections.setBaseUrl(req.membership.workspaceId, id, body.base_url);
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

  @Post(':id/resume')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'MN-264: manually close the circuit breaker before its cool-down elapses' })
  resume(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.connections.resume(req.membership.workspaceId, id);
  }

  @Get('oauth/:provider/start')
  @MinRole('admin')
  @RequiresScope('admin')
  @ApiOperation({ summary: 'Begin an OAuth2 connect (redirects to the provider)' })
  start(@Req() req: WorkspaceRequest, @Param('provider') provider: string, @Res() reply: FastifyReply) {
    // #1048: the state's nonce rides in a cookie on THIS browser; the callback refuses the state from any other.
    const { url, nonce } = this.connections.startOAuth(req.membership.workspaceId, provider, req.user.id);
    void reply.header('set-cookie', nonceCookie(nonce));
    redirect(reply, url);
  }
}
