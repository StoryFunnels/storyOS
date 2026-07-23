import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { packSubmissionReviewRequestSchema, packSubmissionStatusSchema } from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { AgentsService } from '../agents/agents.service';
import { MarketplaceService } from '../packs/marketplace.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRunsService } from './admin-runs.service';
import { CostAttributionService } from './cost-attribution.service';

class ReviewSubmissionDto extends createZodDto(packSubmissionReviewRequestSchema) {}

/**
 * MN-104 first cut: read-only, platform-admin-gated. No mutations here yet —
 * impersonation, token revoke, billing ops (comp/refund/plan-change), GDPR
 * tooling, and the security audit log are all deliberately NOT built in this
 * pass; each is its own careful, safety-reviewed piece of work, not a
 * bolt-on. This ships the guard + the Overview/Workspaces read surface the
 * ticket's own design notes call out as the starting point.
 *
 * #300/MN-216c adds the one exception to "no mutations": a run cancel
 * kill-switch. It gets the same deliberate, separately-reviewed treatment
 * this doc comment asks for everything else — see AgentsService.
 * adminCancelRun's own doc comment for why it's a pure status flip and
 * nothing more.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(
    private readonly overview: AdminOverviewService,
    private readonly costs: CostAttributionService,
    private readonly runs: AdminRunsService,
    private readonly agents: AgentsService,
    private readonly marketplace: MarketplaceService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Instance-wide counts: workspaces, users, records, plan mix, estimated MRR.' })
  async getOverview() {
    return this.overview.getOverview();
  }

  @Get('workspaces')
  @ApiOperation({ summary: 'Every workspace on the instance: plan, seats, record count.' })
  async listWorkspaces() {
    return this.overview.listWorkspaces();
  }

  @Get('costs')
  @ApiOperation({
    summary:
      'MN-194 — per-workspace cost and margin from real usage (hosted calls, storage, email; AI cost estimated pending MN-214r), plus blended margin per plan and the margin-floor flags.',
  })
  async getCosts() {
    return this.costs.getCostOverview();
  }

  @Get('runs')
  @ApiOperation({
    summary:
      '#300/MN-216c — agent runs across every workspace: workspace, agent, status, run_class, trigger, started/finished. Read-only.',
  })
  async listRuns() {
    return this.runs.listRuns();
  }

  @Post('runs/:workspaceId/:run/cancel')
  @ApiParam({ name: 'workspaceId', description: "The run's workspace id" })
  @ApiParam({ name: 'run', description: "The run record's id" })
  @ApiOperation({
    summary:
      '#300/MN-216c — kill switch: cancel a queued/running/waiting-approval run in any workspace. A status flip to Canceled only — no other side effects.',
  })
  async cancelRun(
    @Req() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('run') run: string,
  ) {
    return this.agents.adminCancelRun(workspaceId, run, req.user.id);
  }

  /**
   * MN-220 — the Community Marketplace moderation queue. `?status=pending`
   * (the default a reviewer wants) filters to what's actually actionable;
   * omit it to see the full history including past approve/reject decisions.
   */
  @Get('packs/submissions')
  @ApiOperation({
    summary: 'MN-220 — pack marketplace submissions awaiting (or having had) review',
  })
  listPackSubmissions(@Query('status') status?: string) {
    const parsed = packSubmissionStatusSchema.optional().safeParse(status);
    return this.marketplace.listAllSubmissions(parsed.success ? parsed.data : undefined);
  }

  /**
   * MN-220 — the one mutation moderation has: approve publishes the
   * submission (creating or version-bumping its `published_packs` row);
   * reject just annotates it. Neither ever half-applies — see
   * `MarketplaceService.review`'s doc.
   */
  @Post('packs/submissions/:id/review')
  @ApiParam({ name: 'id', description: 'The submission id' })
  @ApiOperation({ summary: 'MN-220 — approve or reject a pending pack submission' })
  reviewPackSubmission(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReviewSubmissionDto,
  ) {
    return this.marketplace.review(req.user.id, id, body.action, body.notes);
  }
}
