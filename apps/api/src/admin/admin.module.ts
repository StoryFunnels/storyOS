import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminOverviewService } from './admin-overview.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Deliberately not importing AccessModule: it's @Global() (see its own
 * comment — the same MN-190 cycle-avoidance lesson), so AccessService is
 * already resolvable here without adding an edge.
 */
@Module({
  controllers: [AdminController],
  providers: [PlatformAdminService, PlatformAdminGuard, AdminOverviewService],
  exports: [PlatformAdminService],
})
export class AdminModule {}
