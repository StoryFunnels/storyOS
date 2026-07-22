import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AutomationsModule } from '../automations/automations.module';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { SkillsModule } from '../skills/skills.module';
import { ViewsModule } from '../views/views.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PacksController, PacksRegistryController } from './packs.controller';
import { PacksService } from './packs.service';

/**
 * Business Packs (MN-218 / #160).
 *
 * Imports rather than reimplements: the schema half of an install is
 * `ArchitectService.build` from AgentsModule, everything else goes through
 * the same views/automations/records/skills services a person's HTTP client
 * drives. Like the Architect, this module adds no engine privilege the CRUD
 * API does not already expose — a pack can only build what you could build
 * by hand.
 */
@Module({
  imports: [
    AgentsModule,
    AutomationsModule,
    DatabasesModule,
    FieldsModule,
    RecordsModule,
    RelationsModule,
    SkillsModule,
    ViewsModule,
    WorkspacesModule,
  ],
  controllers: [PacksController, PacksRegistryController],
  providers: [PacksService],
  exports: [PacksService],
})
export class PacksModule {}
