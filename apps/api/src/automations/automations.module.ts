import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { BillingModule } from '../billing/billing.module';
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
  imports: [
    WebhooksModule,
    DatabasesModule,
    RecordsModule,
    RelationsModule,
    CollaborationModule,
    NotificationsModule,
    IntegrationsModule,
    BillingModule,
  ],
  controllers: [ButtonsController, AutomationsController],
  providers: [AutomationActionsService, AutomationsService],
  exports: [AutomationActionsService, AutomationsService],
})
export class AutomationsModule {}
