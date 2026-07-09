import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GithubService } from './github.service';
import { LinearService } from './linear.service';

class GithubConfigDto extends createZodDto(
  z.object({
    token: z.string().min(1).max(255).optional(),
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(20).optional(),
  }),
) {}

class LinearConfigDto extends createZodDto(
  z.object({
    api_key: z.string().min(1).max(255).optional(),
    team_keys: z.array(z.string().min(1).max(20)).max(20).optional(),
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

/** Linear importer (MN-066): one-shot GraphQL migration into dev-project shapes. Admin-only. */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/integrations/linear')
export class LinearIntegrationsController {
  constructor(private readonly linear: LinearService) {}

  @Get()
  @ApiOperation({ summary: 'Linear config (key presence + team keys)' })
  getConfig(@Req() req: WorkspaceRequest) {
    return this.linear.getConfig(req.membership.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Save Linear API key and/or team-key filter' })
  saveConfig(@Req() req: WorkspaceRequest, @Body() body: LinearConfigDto) {
    return this.linear.saveConfig(req.membership.workspaceId, body);
  }

  @Post('dry-run')
  @ApiOperation({ summary: 'Preview import counts per team — writes nothing' })
  dryRun(@Req() req: WorkspaceRequest) {
    return this.linear.dryRun(req.membership);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Import teams → spaces (Issues/Sprints/Projects), idempotent by Linear ID' })
  sync(@Req() req: WorkspaceRequest) {
    return this.linear.sync(req.membership, req.user.id);
  }
}
