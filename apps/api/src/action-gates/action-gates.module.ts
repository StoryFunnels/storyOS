import { Module } from '@nestjs/common';
import { ActionGatesController } from './action-gates.controller';
import { ActionGatesService } from './action-gates.service';
import { AgentWriteGatesController } from './agent-write-gates.controller';
import { AgentWriteGatesService } from './agent-write-gates.service';

/**
 * #542 Phase 2 — deliberately depends on nothing but the `@Global()` DB and
 * NotificationsService providers (see `ActionGatesService`'s own doc for
 * why): this is what lets `RecordsModule` import it without creating the
 * cycle a direct dependency on `AutomationsModule`/`ApprovalsService` would.
 * #1104's AgentWriteGatesService keeps the same property for the same reason.
 */
@Module({
  controllers: [ActionGatesController, AgentWriteGatesController],
  providers: [ActionGatesService, AgentWriteGatesService],
  exports: [ActionGatesService, AgentWriteGatesService],
})
export class ActionGatesModule {}
