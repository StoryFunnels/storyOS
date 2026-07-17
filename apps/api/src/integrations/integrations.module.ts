import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubService } from './github.service';
import { GithubWebhookService } from './github-webhook.service';
import {
  GithubWebhookController,
  IntegrationsController,
  LinearIntegrationsController,
  SlackIntegrationsController,
} from './integrations.controller';
import { LinearService } from './linear.service';
import { SlackService } from './slack.service';

@Module({
  imports: [DatabasesModule, DocumentsModule, FieldsModule, RecordsModule, RelationsModule, WorkspacesModule],
  controllers: [
    IntegrationsController,
    GithubWebhookController,
    LinearIntegrationsController,
    SlackIntegrationsController,
  ],
  providers: [GithubService, GithubWebhookService, LinearService, SlackService],
  exports: [GithubService, GithubWebhookService, LinearService, SlackService],
})
export class IntegrationsModule {}
