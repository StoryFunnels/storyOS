import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { BillingModule } from '../billing/billing.module';
import { PacksModule } from '../packs/packs.module';
import { RecordsModule } from '../records/records.module';
import { AdminController } from './admin.controller';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRunsService } from './admin-runs.service';
import { AdminBillingService } from './admin-billing.service';
import { CostAttributionService } from './cost-attribution.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Deliberately not importing AccessModule: it's @Global() (see its own
 * comment — the same MN-190 cycle-avoidance lesson), so AccessService is
 * already resolvable here without adding an edge. CostAttributionService
 * (MN-194) only needs pure exports from billing/plans.ts and
 * billing/usage-metering.ts, not any of BillingModule's injectable
 * services, so it needed no edge of its own.
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
 *
 * BillingModule is #304's edge: AdminBillingService.setPlan needs the DB
 * directly (it's the ONE other writer of billing_subscriptions besides
 * BillingService.reconcileSubscription), and the entitlement-override
 * endpoints call EntitlementsService.setOverride/clearOverride directly
 * from the controller — both need BillingModule's exports. BillingModule
 * does not import AdminModule (see its own doc comment's cycle-avoidance
 * notes), so this is one-directional, same as PacksModule/RecordsModule.
 */
@Module({
  imports: [AgentsModule, RecordsModule, PacksModule, BillingModule],
  controllers: [AdminController],
  providers: [
    PlatformAdminService,
    PlatformAdminGuard,
    AdminOverviewService,
    CostAttributionService,
    AdminRunsService,
    AdminBillingService,
  ],
  exports: [PlatformAdminService],
})
export class AdminModule {}
