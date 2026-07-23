import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  adminClearEntitlementOverrideRequestSchema,
  adminSetEntitlementOverrideRequestSchema,
  adminSetPlanRequestSchema,
  packSubmissionReviewRequestSchema,
  packSubmissionStatusSchema,
} from '@storyos/schemas';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { AgentsService } from '../agents/agents.service';
import { MarketplaceService } from '../packs/marketplace.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRunsService } from './admin-runs.service';
import { AdminBillingService } from './admin-billing.service';
import { CostAttributionService } from './cost-attribution.service';

class ReviewSubmissionDto extends createZodDto(packSubmissionReviewRequestSchema) {}
class AdminSetPlanDto extends createZodDto(adminSetPlanRequestSchema) {}
class AdminSetEntitlementOverrideDto extends createZodDto(adminSetEntitlementOverrideRequestSchema) {}
class AdminClearEntitlementOverrideDto extends createZodDto(adminClearEntitlementOverrideRequestSchema) {}

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
 *
 * #304 is the "plan-change" piece this doc comment deferred above —
 * narrowly scoped to exactly what its own ticket specs: setting a
 * workspace's plan and entitlement overrides in OUR OWN tables (never live
 * Stripe — see AdminBillingService.setPlan's doc for why), read back via one
 * read-only billing view. Impersonation/token-revoke/refund/GDPR/audit-log
 * are still explicitly NOT built here — each remains its own future pass.
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
    private readonly adminBilling: AdminBillingService,
    private readonly entitlements: EntitlementsService,
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

  /**
   * #304 — set a workspace's plan directly, bypassing Stripe entirely (no
   * subscription created/touched against the real Stripe account). See
   * AdminBillingService.setPlan's own doc for why stripeSubscriptionId/
   * status are always cleared, even over an existing Stripe-backed row.
   */
  @Post('workspaces/:id/plan')
  @ApiParam({ name: 'id', description: 'Workspace id' })
  @ApiOperation({
    summary: '#304 — set a workspace plan (comp/Enterprise grant); requires a reason; never touches live Stripe',
  })
  async setWorkspacePlan(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AdminSetPlanDto,
  ) {
    await this.adminBilling.setPlan(
      id,
      req.user.id,
      body.plan,
      body.reason,
      body.expires_at ? new Date(body.expires_at) : null,
    );
    return this.adminBilling.getBillingView(id);
  }

  /**
   * #304 — thin wrapper over the EXISTING EntitlementsService.setOverride;
   * no new override storage, no parallel audit mechanism.
   */
  @Post('workspaces/:id/entitlement-overrides')
  @ApiParam({ name: 'id', description: 'Workspace id' })
  @ApiOperation({
    summary: '#304 — set entitlement overrides (e.g. maxWorkspaces) for a workspace; requires a reason',
  })
  async setWorkspaceEntitlementOverride(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AdminSetEntitlementOverrideDto,
  ) {
    const { reason, expires_at, ...patch } = body;
    await this.entitlements.setOverride(
      id,
      req.user.id,
      patch,
      reason,
      expires_at ? new Date(expires_at) : null,
    );
    return this.adminBilling.getBillingView(id);
  }

  /** #304 — thin wrapper over the EXISTING EntitlementsService.clearOverride. */
  @Delete('workspaces/:id/entitlement-overrides')
  @ApiParam({ name: 'id', description: 'Workspace id' })
  @ApiOperation({ summary: '#304 — clear a workspace\'s entitlement overrides; requires a reason' })
  async clearWorkspaceEntitlementOverride(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AdminClearEntitlementOverrideDto,
  ) {
    await this.entitlements.clearOverride(id, req.user.id, body.reason);
    return this.adminBilling.getBillingView(id);
  }

  /**
   * #304 — read-only: current plan, active overrides, and the full
   * entitlement_override_events audit trail for a workspace, so any plan
   * change made above is always inspectable after the fact.
   */
  @Get('workspaces/:id/billing')
  @ApiParam({ name: 'id', description: 'Workspace id' })
  @ApiOperation({ summary: '#304 — current plan + overrides + audit trail for a workspace' })
  async getWorkspaceBilling(@Param('id') id: string) {
    return this.adminBilling.getBillingView(id);
  }
}
