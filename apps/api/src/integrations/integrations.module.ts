import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MigrationFrameworkModule } from '../migration-framework/migration-framework.module';
import { GithubAppService } from './github-app.service';
import { GithubService } from './github.service';
import { GithubReviewsService } from './github-reviews.service';
import { GithubWebhookService } from './github-webhook.service';
import {
  GithubOAuthController,
  GithubReviewSettingsController,
  GithubReviewsController,
  GithubWebhookController,
  IntegrationsController,
  IntegrationsDirectoryController,
  LinearIntegrationsController,
  SlackIntegrationsController,
} from './integrations.controller';
import { LinearService } from './linear.service';
import { SlackService } from './slack.service';

@Module({
  imports: [
    DatabasesModule,
    DocumentsModule,
    FieldsModule,
    RecordsModule,
    RelationsModule,
    UsersModule,
    WorkspacesModule,
    MigrationFrameworkModule,
  ],
  controllers: [
    IntegrationsDirectoryController,
    IntegrationsController,
    GithubReviewsController,
    GithubReviewSettingsController,
    GithubWebhookController,
    GithubOAuthController,
    LinearIntegrationsController,
    SlackIntegrationsController,
  ],
  providers: [GithubAppService, GithubService, GithubReviewsService, GithubWebhookService, LinearService, SlackService],
  exports: [GithubAppService, GithubService, GithubReviewsService, GithubWebhookService, LinearService, SlackService],
})
export class IntegrationsModule {}
