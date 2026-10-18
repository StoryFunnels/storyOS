import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { CredentialsService } from './credentials.service';

/**
 * #882 — credential provenance. Admin-only and read-only: it answers "what could that token reach, and what did it do" for a leaked
 * or misused credential, live or revoked. Not `@ResourceScopable`, so a token bound to spaces/databases is refused outright
 * (deny-by-default, #543), and a member or guest never reaches it (`@MinRole('admin')`): which colleague's token touched what is
 * not theirs to learn.
 */
@ApiTags('credentials')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@RequiresScope('admin')
@Controller('workspaces/:ws')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get('credentials/:id')
  @ApiOperation({ summary: "A credential's scope and window — including after it was revoked or its owner erased (#882)" })
  get(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.credentials.get(req.membership.workspaceId, id);
  }

  @Get('credentials/:id/actions')
  @ApiOperation({ summary: 'Everything one credential did (activity events), newest first (#882)' })
  actions(@Req() req: WorkspaceRequest, @Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.credentials.actions(req.membership.workspaceId, id, cursor);
  }

  @Get('activity-events/:event')
  @ApiOperation({ summary: 'One past action and the credential that performed it (#882)' })
  event(@Req() req: WorkspaceRequest, @Param('event') event: string) {
    return this.credentials.event(req.membership.workspaceId, event);
  }
}
