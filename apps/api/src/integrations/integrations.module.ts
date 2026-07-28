import { Module } from '@nestjs/common';
import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';
import { FieldsModule } from '../fields/fields.module';
import { RecordsModule } from '../records/records.module';
import { RelationsModule } from '../relations/relations.module';
import { SourcesModule } from '../sources/sources.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MigrationFrameworkModule } from '../migration-framework/migration-framework.module';
import { ConnectionsModule } from '../connections/connections.module';
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
  ShopifyIntegrationsController,
  SlackIntegrationsController,
} from './integrations.controller';
import { LinearService } from './linear.service';
import { SlackService } from './slack.service';
import { ShopifyCatalogueService } from './shopify-catalogue.service';
import { ShopifyCatalogueSubscriber } from './shopify-catalogue.subscriber';
import { ShopifyWebhookController } from './shopify-webhook.controller';

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
    ConnectionsModule,
    SourcesModule,
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
    ShopifyIntegrationsController,
    ShopifyWebhookController,
  ],
  providers: [
    GithubAppService,
    GithubService,
    GithubReviewsService,
    GithubWebhookService,
    LinearService,
    SlackService,
    ShopifyCatalogueService,
    ShopifyCatalogueSubscriber,
  ],
  exports: [
    GithubAppService,
    GithubService,
    GithubReviewsService,
    GithubWebhookService,
    LinearService,
    SlackService,
    ShopifyCatalogueService,
  ],
})
export class IntegrationsModule {}
