import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { AdminOverviewService } from './admin-overview.service';

/**
 * MN-104 first cut: read-only, platform-admin-gated. No mutations here yet —
 * impersonation, token revoke, billing ops (comp/refund/plan-change), GDPR
 * tooling, and the security audit log are all deliberately NOT built in this
 * pass; each is its own careful, safety-reviewed piece of work, not a
 * bolt-on. This ships the guard + the Overview/Workspaces read surface the
 * ticket's own design notes call out as the starting point.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(private readonly overview: AdminOverviewService) {}

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
}
