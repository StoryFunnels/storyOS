import { Global, Module } from '@nestjs/common';
import { ActionGatesController } from './action-gates.controller';
import { ActionGatesService } from './action-gates.service';
import { AgentWriteGatesController } from './agent-write-gates.controller';
import { AgentWriteGatesService } from './agent-write-gates.service';
import { AgentDeleteHoldService } from './agent-delete-hold.service';

/**
 * #542 Phase 2 — deliberately depends on nothing but the `@Global()` DB and
 * NotificationsService providers (see `ActionGatesService`'s own doc for
 * why): this is what lets `RecordsModule` import it without creating the
 * cycle a direct dependency on `AutomationsModule`/`ApprovalsService` would.
 * #1104's AgentWriteGatesService keeps the same property for the same reason.
 *
 * #1178 — `@Global()` because AgentDeleteHoldService is called from the delete path of eight domain services (records, comments,
 * attachments, documents, sources, skills, space views, templates, relations) and registers an applier from each. It has the same
 * dependency-free shape (DB + NotificationsService, both global), so making it visible everywhere adds no module edge and no cycle.
 */
@Global()
@Module({
  controllers: [ActionGatesController, AgentWriteGatesController],
  providers: [ActionGatesService, AgentWriteGatesService, AgentDeleteHoldService],
  exports: [ActionGatesService, AgentWriteGatesService, AgentDeleteHoldService],
})
export class ActionGatesModule {}
