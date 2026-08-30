import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { ViewsModule } from '../views/views.module';
import { AutomationsModule } from '../automations/automations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TemplatesController, WorkspaceTemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [
    WorkspacesModule,
    DatabasesModule,
    FieldsModule,
    RecordsModule,
    RelationsModule,
    ViewsModule,
    // #455 — packs install their rules through the same AutomationsService the API uses.
    AutomationsModule,
  ],
  controllers: [TemplatesController, WorkspaceTemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
