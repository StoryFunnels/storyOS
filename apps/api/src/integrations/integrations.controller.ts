import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GithubService } from './github.service';

class GithubConfigDto extends createZodDto(
  z.object({
    token: z.string().min(1).max(255).optional(),
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(20).optional(),
  }),
) {}

/** Integrations (MN-065): GitHub token import + refresh. Admin-only. */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/integrations/github')
export class IntegrationsController {
  constructor(private readonly github: GithubService) {}

  @Get()
  @ApiOperation({ summary: 'GitHub config (token presence + repos)' })
  getConfig(@Req() req: WorkspaceRequest) {
    return this.github.getConfig(req.membership.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Save GitHub token and/or repo list' })
  saveConfig(@Req() req: WorkspaceRequest, @Body() body: GithubConfigDto) {
    return this.github.saveConfig(req.membership.workspaceId, body);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Import/refresh Issues + PRs; auto-links PRs to issues by #N / branch refs' })
  sync(@Req() req: WorkspaceRequest) {
    return this.github.sync(req.membership, req.user.id);
  }
}
