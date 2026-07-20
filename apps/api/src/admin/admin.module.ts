import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminOverviewService } from './admin-overview.service';
import { CostAttributionService } from './cost-attribution.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Deliberately not importing AccessModule: it's @Global() (see its own
 * comment — the same MN-190 cycle-avoidance lesson), so AccessService is
 * already resolvable here without adding an edge. Same reasoning covers
 * BillingModule — CostAttributionService (MN-194) only needs pure exports
 * from billing/plans.ts and billing/usage-metering.ts, not any of its
 * injectable services, so no import edge to BillingModule is needed either.
 */
@Module({
  controllers: [AdminController],
  providers: [PlatformAdminService, PlatformAdminGuard, AdminOverviewService, CostAttributionService],
  exports: [PlatformAdminService],
})
export class AdminModule {}
