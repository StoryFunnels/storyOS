import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { BillingModule } from '../billing/billing.module';
import { DatabasesModule } from '../databases/databases.module';
import { MentionsModule } from '../mentions/mentions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';
import { RollupInvalidationSubscriber } from './rollup-invalidation.subscriber';

@Module({
  // #31: BillingModule provides EntitlementsService, which RecordsService needs
  // to know a workspace's history-retention window — Free captures nothing.
  imports: [WorkspacesModule, DatabasesModule, MentionsModule, AbuseModule, BillingModule],
  controllers: [RecordsController],
  providers: [RecordsService, RollupInvalidationSubscriber],
  exports: [RecordsService],
})
export class RecordsModule {}
