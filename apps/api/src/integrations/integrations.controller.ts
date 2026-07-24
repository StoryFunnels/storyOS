import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import type { RawBodyRequest } from '../app.setup';
import { env } from '../config/env';
import { redactSecrets } from '../common/redact-secrets';
import { MinRole, WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { GithubAppService } from './github-app.service';
import { GithubService } from './github.service';
import { GithubWebhookService } from './github-webhook.service';
import type { ReviewBucket } from './github-reviews.service';
import { GithubReviewsService } from './github-reviews.service';
import { INTEGRATION_REGISTRY } from './integration-registry';
import { LinearService } from './linear.service';
import { PreferencesService } from '../users/preferences.service';
import { SlackService } from './slack.service';
import { ConnectionsService } from '../connections/connections.service';

/** 302 redirect via the raw Fastify reply (Nest passthrough is off under @Res). */
function redirect(reply: FastifyReply, url: string): void {
  void reply.header('location', url).code(302).send();
}

/**
 * The integrations directory (#44): the registry's static metadata plus each
 * platform's live `connected` status, in one round trip — what the gallery at
 * `/settings/integrations` renders generically instead of three separate
 * per-platform queries. Any active member can read it (same "read what's
 * connected, never the credential" split as `ConnectionsController.providers`);
 * connecting/configuring still goes through each platform's own admin-only
 * controller below.
 *
 * The response carries no secret-shaped fields at all today (id/label/status/
 * connected booleans only), but it is still run through `redactSecrets` —
 * the same utility every other integration/config response uses — so a field
 * added here later can never silently leak a credential.
 */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/integrations')
export class IntegrationsDirectoryController {
  constructor(
    private readonly github: GithubService,
    private readonly linear: LinearService,
    private readonly slack: SlackService,
    private readonly connections: ConnectionsService,
  ) {}

  @Get()
  @RequiresScope('read')
  @ApiOperation({
    summary: 'Integrations directory — registry metadata + per-integration connected status',
  })
  async list(@Req() req: WorkspaceRequest) {
    const workspaceId = req.membership.workspaceId;
    const [github, linear, slack, connectionRows] = await Promise.all([
      this.github.getConfig(workspaceId),
      this.linear.getConfig(workspaceId),
      this.slack.getConfig(workspaceId),
      this.connections.list(workspaceId),
    ]);
    const connected: Record<string, boolean> = {
      github: Boolean(github.connected || github.has_token),
      linear: Boolean(linear.has_key),
      slack: Boolean(slack.has_token || slack.has_webhook),
      youtube: connectionRows.data.some(
        (connection) => connection.provider === 'google' && connection.status === 'active',
      ),
      'google-calendar': connectionRows.data.some(
        (connection) => connection.provider === 'google-calendar' && connection.status === 'active',
      ),
      // Built-in and always available; there is nothing to "connect".
      'delegate-agent': true,
    };
    // Wire shape is snake_case (`built_by`/`auth_kind`), matching every other
    // response in this file (has_token, default_channel, …) — the registry
    // descriptor itself stays camelCase (ordinary TS convention) because it
    // never leaves the server as-is.
    const data = INTEGRATION_REGISTRY.map((d) => ({
      id: d.id,
      label: d.label,
      built_by: d.builtBy,
      description: d.description,
      auth_kind: d.authKind,
      status: d.status,
      connected: connected[d.id] ?? false,
    }));
    return { data: redactSecrets(data) };
  }
}

/** A state-automation entry: a state-option label, or null to disable the event. */
const stateLabel = z.string().min(1).max(100).nullable().optional();

class GithubConfigDto extends createZodDto(
  z.object({
    token: z.string().min(1).max(255).optional(),
    repos: z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .max(20)
      .optional(),
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
  constructor(
    private readonly github: GithubService,
    private readonly githubApp: GithubAppService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'GitHub config (token presence + repos + App connect state)' })
  getConfig(@Req() req: WorkspaceRequest) {
    return this.github.getConfig(req.membership.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Save GitHub token, repos, webhook secret and/or state automation' })
  saveConfig(@Req() req: WorkspaceRequest, @Body() body: GithubConfigDto) {
    // The caller becomes the identity webhook-driven writes act as (#42).
    return this.github.saveConfig(req.membership.workspaceId, body, req.user.id);
  }

  /**
   * #247 AC 1: start the GitHub App connect. Signs a CSRF `state` carrying this
   * workspace id and 302s the admin to GitHub's install/authorize screen. 404s
   * cleanly when the server has no GitHub App configured (feature unavailable) —
   * the manual webhook_secret + PAT path is unaffected.
   */
  @Get('connect')
  @ApiOperation({ summary: 'Begin GitHub App OAuth connect (redirects to GitHub)' })
  connect(@Req() req: WorkspaceRequest, @Res() reply: FastifyReply) {
    this.requireAppConfigured();
    const state = this.githubApp.signState(req.membership.workspaceId);
    redirect(reply, this.githubApp.authorizeUrl(state));
  }

  /**
   * #247 repo picker: list the connected installation's repos so an admin can
   * choose which ones StoryOS watches. The chosen subset is stored via the
   * ordinary POST above (`repos`).
   */
  @Get('repos')
  @ApiOperation({ summary: "List the connected installation's repositories" })
  async repos(@Req() req: WorkspaceRequest) {
    this.requireAppConfigured();
    const config = await this.github.readConfig(req.membership.workspaceId);
    if (config.installation_id === undefined || config.installation_id === null) {
      throw new BadRequestException('Connect the GitHub App before listing repositories');
    }
    const available = await this.githubApp.listRepos(config.installation_id);
    return { repos: available, selected: config.repos ?? [] };
  }

  @Post('sync')
  @ApiOperation({
    summary: 'Import/refresh Issues + PRs; auto-links PRs to issues by #N / branch refs',
  })
  sync(@Req() req: WorkspaceRequest) {
    return this.github.sync(req.membership, req.user.id);
  }

  /** MN-249: the directory's per-row "Disconnect" action — clears token/App install/repos. */
  @Post('disconnect')
  @ApiOperation({ summary: 'Disconnect GitHub — clears token, App installation and watched repos' })
  disconnect(@Req() req: WorkspaceRequest) {
    return this.github.disconnect(req.membership.workspaceId);
  }

  private requireAppConfigured(): void {
    if (!this.githubApp.isConfigured()) {
      throw new NotFoundException('GitHub App connect is not configured on this server');
    }
  }
}

const reviewCommentSchema = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']),
  body: z.string().min(1).max(65536),
});
class ReviewCommentDto extends createZodDto(reviewCommentSchema) {}

class ReviewReplyDto extends createZodDto(z.object({ body: z.string().min(1).max(65536) })) {}

class ReviewReactionDto extends createZodDto(
  z.object({
    // GitHub's fixed reaction-content set.
    content: z.enum(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
  }),
) {}

class SubmitReviewDto extends createZodDto(
  z.object({
    event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string().max(65536).optional(),
  }),
) {}

class ReviewSettingsDto extends createZodDto(
  z.object({
    enabled: z.boolean().optional(),
    auto_convert_draft: z.boolean().optional(),
    default_merge_strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
    code_theme: z.enum(['auto', 'light', 'dark']).optional(),
    code_font: z.enum(['mono', 'mono_lig', 'system']).optional(),
    notifications: z
      .object({
        review_requests: z.boolean().optional(),
        comments_mentions: z.boolean().optional(),
      })
      .partial()
      .optional(),
  }),
) {}

/**
 * In-app code review (#43): the Reviews sidebar (needs-my-review / authored /
 * participating), PR detail (files + checks + diff — the diff itself is just
 * GitHub's own `patch` text per file, rendered client-side), inline comments
 * synced bi-directionally with GitHub, and Approve/Request-changes/Comment.
 *
 * `member`, not `admin` — reviewing code is an ordinary contributor action,
 * unlike the secret-bearing config above. It still 422s cleanly if GitHub
 * itself isn't connected/enabled (`GithubReviewsService.token`).
 */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('member')
@Controller('workspaces/:ws/integrations/github/reviews')
export class GithubReviewsController {
  constructor(
    private readonly reviews: GithubReviewsService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Reviews sidebar: PRs in one bucket (needs_review/authored/participating)',
  })
  async list(@Req() req: WorkspaceRequest, @Query('bucket') bucket?: string) {
    const login = (await this.preferences.get(req.user.id)).github.login;
    if (!login) {
      throw new BadRequestException(
        'Set your GitHub username in preferences before listing reviews',
      );
    }
    const b = (['needs_review', 'authored', 'participating'] as const).includes(
      bucket as ReviewBucket,
    )
      ? (bucket as ReviewBucket)
      : 'needs_review';
    return { data: await this.reviews.list(req.membership, b, login) };
  }

  @Get(':owner/:repo/:number')
  @ApiOperation({ summary: 'PR detail: metadata, changed files (with patch), checks' })
  getPull(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    return this.reviews.getPull(req.membership, owner, repo, number);
  }

  @Get(':owner/:repo/:number/comments')
  @ApiOperation({ summary: 'Cached inline review comments for this PR' })
  listComments(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    return this.reviews.listComments(req.membership, `${owner}/${repo}`, number);
  }

  @Post(':owner/:repo/:number/comments')
  @ApiOperation({ summary: 'Post a new inline (file/line-anchored) review comment' })
  createComment(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: ReviewCommentDto,
  ) {
    return this.reviews.createComment(req.membership, owner, repo, number, body);
  }

  @Post(':owner/:repo/:number/comments/:commentId/replies')
  @ApiOperation({ summary: 'Reply within an existing comment thread' })
  reply(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Param('commentId') commentId: string,
    @Body() body: ReviewReplyDto,
  ) {
    return this.reviews.replyComment(req.membership, owner, repo, number, commentId, body.body);
  }

  @Post(':owner/:repo/:number/comments/:commentId/reactions')
  @ApiOperation({ summary: 'React to a review comment' })
  react(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('commentId') commentId: string,
    @Body() body: ReviewReactionDto,
  ) {
    return this.reviews.react(req.membership, owner, repo, commentId, body.content);
  }

  @Post(':owner/:repo/:number/comments/sync')
  @ApiOperation({ summary: 'Poll GitHub for review comments and refresh the local cache' })
  async syncComments(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
  ) {
    const synced = await this.reviews.syncComments(req.membership, owner, repo, number);
    return { synced };
  }

  @Post(':owner/:repo/:number/reviews')
  @ApiOperation({ summary: 'Approve / Request changes / Comment — submits a GitHub PR review' })
  submitReview(
    @Req() req: WorkspaceRequest,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: SubmitReviewDto,
  ) {
    return this.reviews.submitReview(req.membership, owner, repo, number, body);
  }
}

/** Code & reviews account-level settings (#43 AC 5). Admin-only, like the rest of GitHub config. */
@ApiTags('integrations')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@MinRole('admin')
@Controller('workspaces/:ws/integrations/github/review-settings')
export class GithubReviewSettingsController {
  constructor(private readonly reviews: GithubReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Code & reviews settings (defaulted)' })
  get(@Req() req: WorkspaceRequest) {
    return this.reviews.getSettings(req.membership.workspaceId);
  }

  @Post()
  @ApiOperation({ summary: 'Save Code & reviews settings' })
  save(@Req() req: WorkspaceRequest, @Body() body: ReviewSettingsDto) {
    return this.reviews.saveSettings(req.membership.workspaceId, body);
  }
}

/**
 * #247 AC 1: the OAuth return leg. **Unauthenticated** — GitHub redirects the
 * browser here — so a signed `state` (not any request-supplied ws id) is what
 * proves which workspace the admin started from. A callback whose state doesn't
 * verify is rejected (CSRF).
 */
@ApiTags('integrations')
@Controller('integrations/github')
export class GithubOAuthController {
  constructor(
    private readonly github: GithubService,
    private readonly githubApp: GithubAppService,
  ) {}

  @Get('oauth/callback')
  @ApiOperation({ summary: 'GitHub App OAuth callback — verifies state, captures installation id' })
  async callback(
    @Res() reply: FastifyReply,
    @Query('state') state?: string,
    @Query('installation_id') installationId?: string,
    @Query('code') code?: string,
  ) {
    if (!this.githubApp.isConfigured()) {
      throw new NotFoundException('GitHub App connect is not configured on this server');
    }
    const verified = this.githubApp.verifyState(state);
    if (!verified) throw new BadRequestException('Invalid or expired OAuth state');

    // GitHub's user-auth flow returns a `code`, not an `installation_id` (only the
    // separate install flow sends that). Accept an explicit installation_id when
    // present, otherwise resolve it from the code by asking which installations of
    // this App the authorizing user can reach.
    let instId = Number(installationId);
    if (!Number.isInteger(instId) || instId <= 0) {
      const resolved = code
        ? await this.githubApp.resolveInstallationFromCode(code).catch(() => null)
        : null;
      if (!resolved) {
        throw new BadRequestException(
          'Connected, but the StoryOS GitHub App is not installed on any account yet. ' +
            'Install it on your repositories, then click Connect again.',
        );
      }
      instId = resolved;
    }

    await this.github.saveInstallationId(verified.workspaceId, instId);
    redirect(
      reply,
      `${env().WEB_URL}/w/${verified.workspaceId}/settings/integrations/github?connected=1`,
    );
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
  @ApiOperation({
    summary: 'Import teams → spaces (Issues/Sprints/Projects), idempotent by Linear ID',
  })
  sync(@Req() req: WorkspaceRequest) {
    return this.linear.sync(req.membership, req.user.id);
  }

  /** MN-249: the directory's per-row "Disconnect" action — clears the API key + team filter. */
  @Post('disconnect')
  @ApiOperation({ summary: 'Disconnect Linear — clears the stored API key and team-key filter' })
  disconnect(@Req() req: WorkspaceRequest) {
    return this.linear.disconnect(req.membership.workspaceId);
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

  /** #256 AC: a "Send test message" button so a user can verify the connection without building an automation. */
  @Post('test')
  @ApiOperation({
    summary: 'Send a test message using the saved Slack config, to verify the connection',
  })
  sendTest(@Req() req: WorkspaceRequest) {
    return this.slack.sendMessage(req.membership.workspaceId, { text: 'StoryOS connected ✅' });
  }

  /** MN-249: the directory's per-row "Disconnect" action — clears token/webhook/channel. */
  @Post('disconnect')
  @ApiOperation({
    summary: 'Disconnect Slack — clears the stored bot token, webhook and default channel',
  })
  disconnect(@Req() req: WorkspaceRequest) {
    return this.slack.disconnect(req.membership.workspaceId);
  }
}
