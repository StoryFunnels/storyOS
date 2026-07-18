import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { BillingModule } from '../billing/billing.module';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ArchitectController } from './architect.controller';
import { ArchitectService } from './architect.service';
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
 *
 * The approval gate (#210, ADR-0010 §4) adds no executor and no notifier of its
 * own: an approved action applies through AutomationsModule's shared action
 * service, and the owner is asked through the Inbox (#38). Staging is the only
 * new mechanism — the rest is plumbing that already exists.
 *
 * The Architect (#213/#214, ADR-0010 §6) adds no provider beyond itself and no
 * imports at all: it is a *client* of the very same services listed above —
 * "it needs no engine privilege the CRUD API does not already expose" — which is
 * why it lives here rather than in a module of its own.
 */
@Module({
  imports: [
    AutomationsModule,
    BillingModule,
    DatabasesModule,
    FieldsModule,
    NotificationsModule,
    RecordsModule,
    RelationsModule,
    WorkspacesModule,
  ],
  controllers: [AgentsController, ArchitectController],
  providers: [AgentsService, ArchitectService, AgentTriggerSubscriber],
  exports: [AgentsService, ArchitectService],
})
export class AgentsModule {}
