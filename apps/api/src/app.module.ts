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
import { DocumentsModule } from './documents/documents.module';
import { TokensModule } from './tokens/tokens.module';
import { CollaborationModule } from './comments/collaboration.module';
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
    DocumentsModule,
    TokensModule,
    CollaborationModule,
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
