import { Body, Controller, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { RawBodyRequest } from '../app.setup';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GithubService } from './github.service';
import { GithubWebhookService } from './github-webhook.service';
import { LinearService } from './linear.service';
import { SlackService } from './slack.service';

/** A state-automation entry: a state-option label, or null to disable the event. */
const stateLabel = z.string().min(1).max(100).nullable().optional();

class GithubConfigDto extends createZodDto(
  z.object({
    token: z.string().min(1).max(255).optional(),
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(20).optional(),
    /** Write-only (AC 6): accepted here, never returned by any response. */
    webhook_secret: z.string().min(16).max(255).optional(),
    link_database_id: z.string().uuid().optional(),
    state_automation: z
      .object({
        opened: stateLabel,
        reopened: stateLabel,
        review_requested: stateLabel,
        review_approved: stateLabel,
        review_changes_requested: stateLabel,
        merged: stateLabel,
        closed: stateLabel,
        pushed: stateLabel,
      })
      .optional(),
  }),
) {}

class LinearConfigDto extends createZodDto(
  z.object({
    api_key: z.string().min(1).max(255).optional(),
    team_keys: z.array(z.string().min(1).max(20)).max(20).optional(),
  }),
) {}

class SlackConfigDto extends createZodDto(
  z.object({
    bot_token: z.string().min(1).max(255).optional(),
    default_channel: z.string().min(1).max(200).optional(),
    webhook_url: z.string().url().max(500).optional(),
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
  @ApiOperation({ summary: 'Save GitHub token, repos, webhook secret and/or state automation' })
  saveConfig(@Req() req: WorkspaceRequest, @Body() body: GithubConfigDto) {
    // The caller becomes the identity webhook-driven writes act as (#42).
    return this.github.saveConfig(req.membership.workspaceId, body, req.user.id);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Import/refresh Issues + PRs; auto-links PRs to issues by #N / branch refs' })
  sync(@Req() req: WorkspaceRequest) {
    return this.github.sync(req.membership, req.user.id);
  }
}

/**
 * Inbound GitHub deliveries (#42). **Unauthenticated by necessity** — GitHub
 * holds no session — so the `x-hub-signature-256` HMAC over the raw body is the
 * only thing standing between a stranger and your records. It is verified before
 * the payload is read at all, and it is what resolves the workspace.
 *
 * Deliberately NOT workspace-scoped in the path: the secret identifies the
 * tenant, so there is no unauthenticated `:ws` parameter for anyone to probe.
 */
@ApiTags('integrations')
@Controller('integrations/github')
export class GithubWebhookController {
  constructor(private readonly webhook: GithubWebhookService) {}

  @Post('webhook')
  // 200, not Nest's default 201: this is an acknowledgement, not a creation, and
  // GitHub's delivery UI reads any 2xx as delivered — 200 is what it expects.
  @HttpCode(200)
  @ApiOperation({ summary: 'GitHub webhook receiver — HMAC-verified, unauthenticated by design' })
  receive(
    @Req() req: RawBodyRequest,
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
  ) {
    // req.rawBody, not req.body: the signature is over the bytes GitHub sent.
    return this.webhook.handle(req.rawBody, signature, event);
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

/**
 * Slack integration (MN-021): store a bot token / webhook so automations can
 * post messages. Admin-only. Phase 2 will add a proper OAuth install flow.
 */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/integrations/slack')
export class SlackIntegrationsController {
  constructor(private readonly slack: SlackService) {}

  @Get()
  @ApiOperation({ summary: 'Slack config (token/webhook presence + default channel)' })
  getConfig(@Req() req: WorkspaceRequest) {
    return this.slack.getConfig(req.membership.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Save Slack bot token, webhook URL and/or default channel' })
  saveConfig(@Req() req: WorkspaceRequest, @Body() body: SlackConfigDto) {
    return this.slack.saveConfig(req.membership.workspaceId, body);
  }
}
