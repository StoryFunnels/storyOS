import { Module } from '@nestjs/common';
import { ActionGatesModule } from '../action-gates/action-gates.module';
import { BillingModule } from '../billing/billing.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DatabasesController } from './databases.controller';
import { DatabasesService } from './databases.service';

@Module({
  // #542 — ActionGatesModule imports nothing itself (by design, see its own
  // doc comment), so both this module and WorkspacesModule can import it
  // directly with no cycle risk.
  //
  // #650 AC2 — BillingModule imports neither this module nor WorkspacesModule
  // (see its own doc comment — AccessModule/ReferralsModule only), so this
  // edge is safe: DatabasesService needs SalesSignalService for the
  // 5th-database trigger.
  imports: [WorkspacesModule, ActionGatesModule, BillingModule],
  controllers: [DatabasesController],
  providers: [DatabasesService],
  exports: [DatabasesService],
})
export class DatabasesModule {}
