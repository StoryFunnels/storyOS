import { Module } from '@nestjs/common';
import { ActionGatesController } from './action-gates.controller';
import { ActionGatesService } from './action-gates.service';

/**
 * #542 Phase 2 — deliberately depends on nothing but the `@Global()` DB and
 * NotificationsService providers (see `ActionGatesService`'s own doc for
 * why): this is what lets `RecordsModule` import it without creating the
 * cycle a direct dependency on `AutomationsModule`/`ApprovalsService` would.
 */
@Module({
  controllers: [ActionGatesController],
  providers: [ActionGatesService],
  exports: [ActionGatesService],
})
export class ActionGatesModule {}
