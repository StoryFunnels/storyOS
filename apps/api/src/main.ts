import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';
import { buildOpenApiDocument } from './openapi.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();

  const document = buildOpenApiDocument(app);
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/v1/openapi.json', async () => document);

  await app.listen(env().PORT, '0.0.0.0');
}

void bootstrap();
