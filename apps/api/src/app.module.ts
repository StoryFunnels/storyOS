import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomUUID } from 'node:crypto';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { MeController } from './auth/me.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { env } from './config/env';
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
  ],
  controllers: [AppController, HealthController, DocsController, MeController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
