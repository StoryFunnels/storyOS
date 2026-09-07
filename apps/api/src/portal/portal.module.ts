import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PortalActivityController } from './portal-activity.controller';
import { PortalActivityService } from './portal-activity.service';
import { PortalRecipientsController } from './portal-recipients.controller';
import { PortalRecipientsService } from './portal-recipients.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [PortalRecipientsController, PortalActivityController],
  providers: [PortalRecipientsService, PortalActivityService],
  // #537 — PortalActivityService is exported so ViewsModule's
  // PublicViewsService (the only writer) can record an access.
  exports: [PortalRecipientsService, PortalActivityService],
})
export class PortalModule {}
