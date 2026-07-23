import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { PacksModule } from '../packs/packs.module';
import { RecordsModule } from '../records/records.module';
import { AdminController } from './admin.controller';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRunsService } from './admin-runs.service';
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
 *
 * RecordsModule and AgentsModule ARE real edges (#300, MN-216c): the
 * cross-workspace runs read goes through RecordsService (AdminRunsService),
 * and the cancel kill-switch is a method on AgentsService itself
 * (`adminCancelRun`) — reused here rather than duplicated.
 *
 * PacksModule is MN-220's edge: marketplace moderation (approve/reject a
 * submission) is a method on `MarketplaceService`, reused here the same way
 * rather than a second copy of the review logic living under /admin.
 * PacksModule does not import AdminModule, so this is one-directional.
 */
@Module({
  imports: [AgentsModule, RecordsModule, PacksModule],
  controllers: [AdminController],
  providers: [
    PlatformAdminService,
    PlatformAdminGuard,
    AdminOverviewService,
    CostAttributionService,
    AdminRunsService,
  ],
  exports: [PlatformAdminService],
})
export class AdminModule {}
