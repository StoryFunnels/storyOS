import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { BillingModule } from '../billing/billing.module';
import { DatabasesModule } from '../databases/databases.module';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';
import { RollupInvalidationSubscriber } from './rollup-invalidation.subscriber';
import { PositionRepairSubscriber } from './position-repair.subscriber';
import { WatcherEmailService } from './watcher-email.service';

@Module({
  // #31: BillingModule provides EntitlementsService, which RecordsService needs
  // to know a workspace's history-retention window — Free captures nothing.
  // #273: UsersModule provides PreferencesService, which WatcherEmailService
  // needs for the record_changed email opt-out gate.
  imports: [WorkspacesModule, DatabasesModule, MentionsModule, AbuseModule, BillingModule, UsersModule],
  controllers: [RecordsController],
  providers: [RecordsService, RollupInvalidationSubscriber, PositionRepairSubscriber, WatcherEmailService],
  exports: [RecordsService],
})
export class RecordsModule {}
