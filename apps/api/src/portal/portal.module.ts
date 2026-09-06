import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PortalRecipientsController } from './portal-recipients.controller';
import { PortalRecipientsService } from './portal-recipients.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [PortalRecipientsController],
  providers: [PortalRecipientsService],
  exports: [PortalRecipientsService],
})
export class PortalModule {}
