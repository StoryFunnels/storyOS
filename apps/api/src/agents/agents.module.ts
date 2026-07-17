import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agents + Runs system databases (MN-214a / #209, ADR-0010 — the Agentic OS
 * foundation). Provisions agents-and-runs-as-records via the shared
 * spaces/databases/fields/relations services and executes manual runs (#208)
 * through the records service, exactly like IntegrationsModule provisions and
 * populates its packs.
 */
@Module({
  imports: [DatabasesModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
