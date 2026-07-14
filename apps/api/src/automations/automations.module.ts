import { Module } from '@nestjs/common';
import { CollaborationModule } from '../comments/collaboration.module';
import { DatabasesModule } from '../databases/databases.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { AutomationActionsService } from './actions.service';
import { ButtonsController } from './buttons.controller';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';

@Module({
  imports: [DatabasesModule, RecordsModule, RelationsModule, CollaborationModule, NotificationsModule, IntegrationsModule],
  controllers: [ButtonsController, AutomationsController],
  providers: [AutomationActionsService, AutomationsService],
  exports: [AutomationActionsService, AutomationsService],
})
export class AutomationsModule {}
