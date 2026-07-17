import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentTriggerSubscriber } from './trigger.subscriber';

/**
 * Agents + Runs + Agent Triggers system databases (MN-214a / #209 / #211,
 * ADR-0010 — the Agentic OS foundation). Provisions agents-runs-and-bindings as
 * records via the shared spaces/databases/fields/relations services and executes
 * runs (#208 manual, #212 state-change) through the records service, exactly
 * like IntegrationsModule provisions and populates its packs.
 *
 * The domain-event bus the trigger subscriber rides comes from the global
 * EventsModule, so it needs no explicit import (as in AutomationsModule).
 */
@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentTriggerSubscriber],
  exports: [AgentsService],
})
export class AgentsModule {}
