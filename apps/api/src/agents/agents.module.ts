import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agents system database (MN-214a, ADR-0010 — the Agentic OS foundation).
 * Provisions agents-as-records via the shared spaces/databases/fields services,
 * exactly like IntegrationsModule provisions its packs.
 */
@Module({
  imports: [DatabasesModule, FieldsModule, WorkspacesModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
