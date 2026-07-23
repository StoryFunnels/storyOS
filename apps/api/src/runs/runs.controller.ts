import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresScope } from '../auth/token-scope.guard';
import { WorkspaceAccessGuard } from '../workspaces/workspace-access.guard';
import type { WorkspaceRequest } from '../workspaces/workspace-access.guard';
import { EntitlementsService } from '../billing/entitlements.service';
import { RunsService } from './runs.service';

/**
 * MN-264 — workspace-wide run history + rerun. See runs.service.ts's module
 * doc for the source_runs scope narrowing (#239 hasn't landed).
 */
@ApiTags('runs')
@UseGuards(AuthGuard, WorkspaceAccessGuard)
@Controller('workspaces/:ws/runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('quota')
  @RequiresScope('read')
  @ApiOperation({ summary: 'Monthly automation-run usage vs the plan allowance, with a pace projection' })
  async quota(@Req() req: WorkspaceRequest) {
    const [limits, usage] = await Promise.all([
      this.entitlements.getLimits(req.membership.workspaceId),
      this.entitlements.getUsage(req.membership.workspaceId),
    ]);
    const now = new Date();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected =
      Number.isFinite(limits.automationRunsPerMonth) && dayOfMonth > 0
        ? Math.round((usage.automationRunsThisMonth / dayOfMonth) * daysInMonth)
        : null;
    return {
      used: usage.automationRunsThisMonth,
      limit: Number.isFinite(limits.automationRunsPerMonth) ? limits.automationRunsPerMonth : null,
      projected,
    };
  }

  @Get()
  @RequiresScope('read')
  @ApiOperation({
    summary:
      'Every automation run in the workspace, newest first — rule runs today (source syncs pending #239)',
  })
  async list(
    @Req() req: WorkspaceRequest,
    @Query('kind') kind?: 'rule' | 'source',
    @Query('status') status?: string,
    @Query('rule_id') ruleId?: string,
    @Query('database_id') databaseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.runs.list(req.membership.workspaceId, req.membership, {
      kind,
      status,
      rule_id: ruleId,
      database_id: databaseId,
      from,
      to,
      q,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Get(':id')
  @RequiresScope('read')
  @ApiOperation({ summary: 'Run detail: trigger context, per-action attempts/artifacts, approval linkage' })
  async detail(@Req() req: WorkspaceRequest, @Param('id') id: string) {
    return this.runs.detail(req.membership.workspaceId, req.membership, id);
  }

  @Post(':id/actions/:index/rerun')
  @RequiresScope('write')
  @ApiOperation({ summary: 'Re-run one failed action from this run with its original frozen inputs' })
  async rerun(
    @Req() req: WorkspaceRequest,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.runs.rerun(req.membership.workspaceId, req.membership, id, index);
  }
}
