import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomUUID } from 'node:crypto';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { MeController } from './auth/me.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DatabasesModule } from './databases/databases.module';
import { FieldsModule } from './fields/fields.module';
import { RecordsModule } from './records/records.module';
import { RelationsModule } from './relations/relations.module';
import { ViewsModule } from './views/views.module';
import { ExportModule } from './export/export.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DocumentsModule } from './documents/documents.module';
import { TokensModule } from './tokens/tokens.module';
import { CollaborationModule } from './comments/collaboration.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { FilesModule } from './files/files.module';
import { UsersModule } from './users/users.module';
import { SearchModule } from './search/search.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ImportModule } from './import/import.module';
import { AutomationsModule } from './automations/automations.module';
import { EventsModule } from './events/events.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AgentsModule } from './agents/agents.module';
import { TemplatesModule } from './templates/templates.module';
import { PacksModule } from './packs/packs.module';
import { AccessModule } from './access/access.module';
import { FavoritesModule } from './favorites/favorites.module';
import { MentionsModule } from './mentions/mentions.module';
import { FormsModule } from './forms/forms.module';
import { GdprModule } from './gdpr/gdpr.module';
import { BillingModule } from './billing/billing.module';
import { env } from './config/env';
import { ApiThrottlerGuard } from './common/throttler.guard';
import { DbModule } from './db/db.module';
import { DocsController } from './docs/docs.controller';
import { HealthController } from './health/health.controller';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req) =>
          (req.headers['x-request-id'] as string | undefined) ?? `req_${randomUUID()}`,
        level: env().NODE_ENV === 'test' ? 'silent' : 'info',
        transport:
          env().NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        autoLogging: { ignore: (req) => req.url === '/healthz' },
        /**
         * pino's default `req` serializer logs `headers` verbatim, so every single
         * request was writing its `authorization: Bearer mn_pat_…` and its session
         * cookie into the log at info level. A secret in a log file is the same
         * leak as a secret in a response — logs get shipped, tailed and retained
         * far more casually than an API payload.
         *
         * `censor` (not `remove`) so "was a token even sent?" stays answerable
         * while debugging auth.
         */
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.headers["x-hub-signature-256"]',
            'res.headers["set-cookie"]',
          ],
          censor: '[redacted]',
        },
      },
    }),
    DbModule,
    AuthModule,
    WorkspacesModule,
    DatabasesModule,
    FieldsModule,
    RecordsModule,
    RelationsModule,
    ViewsModule,
    ExportModule,
    WebhooksModule,
    DocumentsModule,
    TokensModule,
    CollaborationModule,
    AttachmentsModule,
    FilesModule,
    UsersModule,
    SearchModule,
    NotificationsModule,
    ImportModule,
    AutomationsModule,
    EventsModule,
    IntegrationsModule,
    AgentsModule,
    TemplatesModule,
    PacksModule,
    AccessModule,
    FavoritesModule,
    MentionsModule,
    FormsModule,
    GdprModule,
    BillingModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: env().RATE_LIMIT_PER_MINUTE }],
    }),
  ],
  controllers: [AppController, HealthController, DocsController, MeController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ApiThrottlerGuard },
  ],
})
export class AppModule {}
