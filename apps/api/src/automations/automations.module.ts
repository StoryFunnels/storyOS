import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { BillingModule } from '../billing/billing.module';
import { CollaborationModule } from '../comments/collaboration.module';
import { ConnectionsModule } from '../connections/connections.module';
import { DatabasesModule } from '../databases/databases.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { AutomationActionsService } from './actions.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ButtonsController } from './buttons.controller';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { HooksController } from './hooks.controller';
import { HookRateLimiterService } from './hook-rate-limiter.service';
import { HttpRequestActionService } from './http-request-action.service';
import { JobRunnerService } from './job-runner.service';
import { SendEmailActionService } from './send-email.action';

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
    ConnectionsModule,
  ],
  controllers: [ButtonsController, AutomationsController, HooksController, ApprovalsController],
  providers: [
    AutomationActionsService,
    AutomationsService,
    HookRateLimiterService,
    JobRunnerService,
    ApprovalsService,
    SendEmailActionService,
    // MN-263: registers the 'http_request' executor with JobRunnerService at
    // boot (onModuleInit) — never referenced directly outside this module
    // except by AutomationsService for the editor's "send test request".
    HttpRequestActionService,
  ],
  exports: [AutomationActionsService, AutomationsService, JobRunnerService, ApprovalsService, HttpRequestActionService],
})
export class AutomationsModule {}
