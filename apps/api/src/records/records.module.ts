import { forwardRef, Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { ActionGatesModule } from '../action-gates/action-gates.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BillingModule } from '../billing/billing.module';
import { DatabasesModule } from '../databases/databases.module';
import { ValidationEnforcerModule } from '../validation-rules/validation-enforcer.module';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { ViewerStateModule } from '../viewer-state/viewer-state.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsController } from './records.controller';
import { RecordIdentifiersController } from './record-identifiers.controller';
import { RecordsService } from './records.service';
import { RollupInvalidationSubscriber } from './rollup-invalidation.subscriber';
import { PositionRepairSubscriber } from './position-repair.subscriber';
import { TitleLocalBackfillSubscriber } from './title-local-backfill.subscriber';
import { WatcherEmailService } from './watcher-email.service';
import { BulkRecordJobsService } from './bulk-record-jobs.service';
import { ViewCreateContextService } from './view-create-context.service';

@Module({
  // #31: BillingModule provides EntitlementsService, which RecordsService needs
  // to know a workspace's history-retention window — Free captures nothing.
  // #273: UsersModule provides PreferencesService, which WatcherEmailService
  // needs for the record_changed email opt-out gate.
  // #599: AttachmentsModule already imports RecordsModule for its own access
  // guards; forwardRef breaks the resulting cycle in both directions.
  imports: [
    WorkspacesModule,
    DatabasesModule,
    ValidationEnforcerModule,
    forwardRef(() => MentionsModule),
    AbuseModule,
    BillingModule,
    UsersModule,
    ActionGatesModule,
    ViewerStateModule, // ticket #1333: ViewCreateContextService reads the caller's personal view filter
    forwardRef(() => AttachmentsModule),
  ],
  controllers: [RecordsController, RecordIdentifiersController],
  providers: [RecordsService, RollupInvalidationSubscriber, PositionRepairSubscriber, TitleLocalBackfillSubscriber, WatcherEmailService, BulkRecordJobsService, ViewCreateContextService],
  exports: [RecordsService, BulkRecordJobsService],
})
export class RecordsModule {}
