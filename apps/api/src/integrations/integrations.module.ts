import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubService } from './github.service';
import { IntegrationsController, LinearIntegrationsController, SlackIntegrationsController } from './integrations.controller';
import { LinearService } from './linear.service';
import { SlackService } from './slack.service';

@Module({
  imports: [DatabasesModule, DocumentsModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [IntegrationsController, LinearIntegrationsController, SlackIntegrationsController],
  providers: [GithubService, LinearService, SlackService],
  exports: [GithubService, LinearService, SlackService],
})
export class IntegrationsModule {}
