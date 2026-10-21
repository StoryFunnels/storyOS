import { Controller, Delete, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { AiConnectionsService } from './ai-connections.service';

class ListQueryDto extends createZodDto(z.object({ workspace_id: z.uuid() })) {}

/**
 * Ticket #1008 — "Connect your AI": which clients the signed-in person has connected, and the disconnect. Per PERSON, like `/me/tokens`,
 * so there is no workspace guard: the workspace is a query argument checked against the caller's own memberships.
 */
@ApiTags('tokens')
@ApiBearerAuth()
@Controller('me/ai-connections')
@UseGuards(AuthGuard)
export class AiConnectionsController {
  constructor(private readonly connections: AiConnectionsService) {}

  @Get()
  @ApiOperation({
    summary:
      'The AI clients I have connected, as one list: hosted-MCP OAuth clients (Claude, ChatGPT, ...) and my personal access tokens for this workspace, with name, method and since when',
  })
  list(@Req() req: AuthedRequest, @Query() query: ListQueryDto) {
    return this.connections.list(req.user.id, query.workspace_id);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Disconnect one of my AI clients (id from the list: oauth:<client> or token:<id>). Needs a signed-in session: an API token or an OAuth client cannot disconnect',
  })
  disconnect(@Req() req: AuthedRequest, @Param('id') id: string) {
    this.connections.assertSession(req.auth?.via);
    return this.connections.disconnect(req.user.id, id);
  }
}
